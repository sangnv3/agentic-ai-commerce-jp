import { createHash } from "node:crypto";
import type { UserContext } from "../auth/entra.js";
import { CommerceError } from "../commerce/errors.js";
import { capturePayment, createOrder } from "../commerce/orders.js";
import { audit } from "../audit/log.js";
import { redis, markStatus, setOutcome } from "./confirmation.js";
import { enqueuePostOrderJobs } from "../jobs/postOrder.js";

/**
 * Post-confirmation pipeline. INTERNAL ONLY — none of these functions is a tool Claude can call.
 * Entry point: POST /api/checkout/confirm (the customer's button press) → runCheckout().
 *
 *   execute_payment ──► create_order ──► (async) create_invoice ──► send_order_email ──► learn preferences
 *
 * Idempotency:
 *   - (user, Idempotency-Key) claimed atomically in Redis: double clicks/retries replay the same outcome.
 *   - The same key goes to the payment gateway, payments.idempotency_key and orders.idempotency_key (UNIQUE).
 */
export type CheckoutOutcome =
  | { status: "captured"; order_id: string; payment_id: string }
  | { status: "requires_action"; payment_id: string; redirect_url: string }
  | { status: "failed"; code: string; charged: false }
  | { status: "unknown"; payment_id?: string }; // unexpected error after charging may have started — reconciled, never retried blindly

export class IdempotencyConflict extends Error {
  constructor(public code: "IN_PROGRESS" | "KEY_REUSED_WITH_DIFFERENT_REQUEST") {
    super(code);
  }
}

/** If this (user, Idempotency-Key) already finished, return the stored outcome — before touching the cart again. */
export async function replayOutcome(userId: string, idempotencyKey: string): Promise<CheckoutOutcome | "IN_PROGRESS" | null> {
  const raw = await redis.get(`idem:${userId}:${idempotencyKey}`);
  if (!raw) return null;
  const rec = JSON.parse(raw) as { state: string; outcome?: CheckoutOutcome };
  return rec.state === "DONE" && rec.outcome ? rec.outcome : "IN_PROGRESS";
}

export async function runCheckout(ctx: {
  user: UserContext;
  sessionId: string;
  confirmationRequestId: string;
  idempotencyKey: string;
  confirmationToken: string;
  requestFingerprint: string;
}): Promise<CheckoutOutcome> {
  const idemKey = `idem:${ctx.user.userId}:${ctx.idempotencyKey}`;
  const fingerprint = createHash("sha256").update(ctx.requestFingerprint).digest("hex");

  const claimed = await redis.set(idemKey, JSON.stringify({ state: "IN_PROGRESS", fingerprint }), "EX", 86400, "NX");
  if (!claimed) {
    const existing = JSON.parse((await redis.get(idemKey)) ?? "{}") as { state: string; fingerprint: string; outcome?: CheckoutOutcome };
    if (existing.fingerprint !== fingerprint) throw new IdempotencyConflict("KEY_REUSED_WITH_DIFFERENT_REQUEST");
    if (existing.state === "DONE" && existing.outcome) return existing.outcome;
    throw new IdempotencyConflict("IN_PROGRESS");
  }

  let outcome: CheckoutOutcome;
  let paymentId: string | undefined;
  try {
    const payment = await capturePayment(ctx.user.userId, ctx.confirmationToken, `pay:${ctx.idempotencyKey}`);
    paymentId = payment.payment_id ?? undefined;
    if (payment.status === "captured") {
      const order = await createOrder(ctx.user.userId, {
        paymentId: payment.payment_id,
        confirmationRequestId: ctx.confirmationRequestId,
        idempotencyKey: `order:${ctx.idempotencyKey}`,
        placedVia: "agent_chat",
      });
      outcome = { status: "captured", order_id: order.order_id, payment_id: payment.payment_id };
    } else if (payment.status === "requires_action") {
      outcome = { status: "requires_action", payment_id: payment.payment_id, redirect_url: payment.redirect_url };
    } else {
      outcome = { status: "failed", code: payment.code, charged: false };
    }
  } catch (e) {
    // A business error raised before charging (sold out, stale cart, slot full, bad token) means nothing was charged.
    // Anything else after a payment row exists is UNKNOWN and goes to reconciliation.
    if (e instanceof CommerceError && !paymentId) outcome = { status: "failed", code: e.code, charged: false };
    else {
      console.error("[checkout] unexpected error", e);
      outcome = { status: "unknown", payment_id: paymentId };
    }
  }

  await redis.set(idemKey, JSON.stringify({ state: "DONE", fingerprint, outcome }), "EX", 86400);
  await markStatus(ctx.confirmationRequestId, outcome.status === "captured" ? "CONSUMED" : outcome.status === "failed" ? "STALE" : "TOKEN_ISSUED");
  await setOutcome(ctx.confirmationRequestId, outcome);
  await audit({
    sessionId: ctx.sessionId,
    userId: ctx.user.userId,
    actor: "user_ui",
    eventType: "payment_event",
    toolName: "execute_payment+create_order",
    toolInput: { confirmation_request_id: ctx.confirmationRequestId, idempotency_key: ctx.idempotencyKey },
    toolOutput: outcome,
  });

  if (outcome.status === "captured") enqueuePostOrderJobs({ orderId: outcome.order_id, userId: ctx.user.userId });
  return outcome;
}
