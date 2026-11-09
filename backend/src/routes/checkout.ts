import { Router } from "express";
import { z } from "zod";
import { requireEntraUser } from "../auth/entra.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { rateLimit } from "../http/security.js";
import { config } from "../config.js";
import { prepareCheckout } from "../commerce/cart.js";
import { audit } from "../audit/log.js";
import { ConfirmationError, getConfirmationRequest, issueConfirmationToken, markStatus, setOutcome } from "../checkout/confirmation.js";
import { IdempotencyConflict, replayOutcome, runCheckout } from "../checkout/fulfillment.js";

/**
 * HUMAN-IN-THE-LOOP endpoints. Called only by the confirmation screen in the browser — never by Claude.
 */
export const checkoutRouter = Router();
checkoutRouter.use(requireEntraUser);

/** Summary for the confirmation screen, computed by the server (not model text). */
checkoutRouter.get("/confirmation-requests/:id", asyncHandler(async (req, res) => {
  const r = await getConfirmationRequest(req.params.id);
  if (!r || r.userId !== req.user!.userId) return res.status(404).json({ code: "NOT_FOUND" });
  res.json({ id: r.id, session_id: r.sessionId, status: r.status, expires_at: new Date(r.expiresAt).toISOString(), summary: r.summary });
}));

checkoutRouter.post("/confirmation-requests/:id/cancel", asyncHandler(async (req, res) => {
  const r = await getConfirmationRequest(req.params.id);
  if (!r || r.userId !== req.user!.userId) return res.status(404).json({ code: "NOT_FOUND" });
  await markStatus(r.id, "STALE");
  res.status(204).end();
}));

const ConfirmBody = z
  .object({
    confirmation_request_id: z.string().startsWith("cr_"),
    cart_version: z.number().int(),
    displayed_total: z.number().int().nonnegative(),
  })
  .strict();

/** The "確認して支払う / Confirm & Pay" button. */
checkoutRouter.post("/confirm", rateLimit("confirm", 10, 60), asyncHandler(async (req, res) => {
  const user = req.user!;

  // Browser-origin + CSRF (double-submit cookie): this endpoint must be driven by a real click in our SPA.
  if (req.header("origin") !== config.webOrigin) return res.status(403).json({ code: "BAD_ORIGIN" });
  const csrfHeader = req.header("x-csrf-token");
  const csrfCookie = /(?:^|;\s*)csrf=([^;]+)/.exec(req.header("cookie") ?? "")?.[1];
  if (!csrfHeader || csrfHeader !== csrfCookie) return res.status(403).json({ code: "CSRF" });

  const idempotencyKey = req.header("idempotency-key");
  if (!idempotencyKey || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED" });

  const body = ConfirmBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: "INVALID_INPUT" });
  const { confirmation_request_id, cart_version, displayed_total } = body.data;

  const request = await getConfirmationRequest(confirmation_request_id);
  if (!request || request.userId !== user.userId) return res.status(404).json({ code: "NOT_FOUND" });

  // Double click / network retry with the same key: answer from the stored result, never re-run the payment.
  const previous = await replayOutcome(user.userId, idempotencyKey);
  if (previous === "IN_PROGRESS") return res.status(409).json({ code: "IN_PROGRESS" });
  if (previous) return res.status({ captured: 200, requires_action: 202, unknown: 202, failed: 402 }[previous.status]).json(previous);

  try {
    // Fresh cart state from the source of truth.
    const current = await prepareCheckout(user.userId);

    // Mint the confirmation_token. It never leaves the backend and is never shown to Claude.
    const { token } = await issueConfirmationToken({
      confirmationRequestId: confirmation_request_id,
      userId: user.userId,
      displayedCartVersion: cart_version,
      displayedTotal: displayed_total,
      currentCart: current,
    });
    await audit({ sessionId: request.sessionId, userId: user.userId, actor: "user_ui", eventType: "confirmation_issued", toolInput: { confirmation_request_id, cart_version, displayed_total } });

    const outcome = await runCheckout({
      user,
      sessionId: request.sessionId,
      confirmationRequestId: confirmation_request_id,
      idempotencyKey,
      confirmationToken: token,
      requestFingerprint: `${confirmation_request_id}:${displayed_total}`,
    });

    // The browser then asks the agent to report it: POST /api/agent/sessions/:id/messages {event:{checkout_result}}.
    const httpStatus = { captured: 200, requires_action: 202, unknown: 202, failed: 402 }[outcome.status];
    return res.status(httpStatus).json(outcome);
  } catch (e) {
    if (e instanceof ConfirmationError) {
      // Stale/expired screen: the agent re-plans (e.g. cart changed) when the browser reports it.
      if (e.code !== "FORBIDDEN" && e.code !== "NOT_FOUND") await setOutcome(confirmation_request_id, { status: "rejected", code: e.code, charged: false });
      return res.status(409).json({ code: e.code });
    }
    if (e instanceof IdempotencyConflict) return res.status(409).json({ code: e.code });
    throw e;
  }
}));
