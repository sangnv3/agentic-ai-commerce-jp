import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireEntraUser } from "../auth/entra.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { rateLimit } from "../http/security.js";
import { runAgentTurn, type Emit, type TurnInput } from "../agent/loop.js";
import { appendTranscript, getTranscript, listSessions, loadSession, newSession, saveSession, setSessionOrder, withSessionLock } from "../agent/sessionStore.js";
import { invalidateForUser, takeOutcomeForReport } from "../checkout/confirmation.js";
import { learnFromReview } from "../jobs/postOrder.js";
import { orderReceipt } from "../commerce/orders.js";
import { addToCart, getCart } from "../commerce/cart.js";
import { getMenuItem, getMenuItems } from "../commerce/catalog.js";
import { CommerceError } from "../commerce/errors.js";

export const agentRouter = Router();
agentRouter.use(requireEntraUser);

function openSse(res: Response): Emit {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let id = 0;
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => clearInterval(heartbeat));
  return (event, data) => {
    res.write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** POST /api/agent/sessions → create a chat session. */
agentRouter.post("/sessions", rateLimit("session", 20, 3600), asyncHandler(async (req, res) => {
  const user = req.user!;
  const session = newSession(`cs_${randomUUID()}`, user.userId, req.body?.locale === "en" ? "en" : user.locale);
  await saveSession(session);
  res.status(201).json({ session_id: session.sessionId });
}));

const MessageBody = z.union([
  z.object({ text: z.string().max(2000), client_message_id: z.string().optional() }).strict(),
  // Sent by the confirmation screen after the button press. Only the id travels from the client;
  // the outcome is read from the server-side record, so the browser cannot forge a "payment succeeded".
  z.object({ event: z.object({ type: z.literal("checkout_result"), confirmation_request_id: z.string() }).strict() }).strict(),
  // "Order" pressed on a home-page menu card: the backend adds the item to the cart itself (with the usual stock,
  // allergen and one-restaurant checks), then the agent takes over for the delivery time and address.
  z.object({ event: z.object({ type: z.literal("home_order"), item_id: z.string().regex(/^itm_[A-Za-z0-9_]{1,40}$/) }).strict() }).strict(),
]);

/** Add the home-page item to the cart. Business errors (sold out, allergen, other restaurant…) go to the agent. */
async function addHomeOrderItem(userId: string, itemId: string, extraAllergens: string[], locale: "ja" | "en") {
  const m = await getMenuItem(itemId).catch(() => null);
  if (!m) return null;
  const item = { item_id: m.itemId, name: m.name, name_en: m.nameEn, restaurant: m.restaurantName, restaurant_name_en: m.restaurantNameEn, price_incl_tax: m.priceInclTax };
  const shown = locale === "en" ? m.nameEn ?? m.name : m.name;
  const userText = locale === "en" ? `Order "${shown}"` : `「${shown}」を注文`;
  try {
    // "Order" = order this dish now: it replaces an unfinished cart (the agent says what was removed).
    let dropped: { itemId: string; quantity: number }[] = [];
    const cart = await addToCart(userId, { itemId: m.itemId, quantity: 1, addedBy: "user", replaceCart: true }, extraAllergens, (d) => (dropped = d));
    const stale = await invalidateForUser(userId); // an open confirmation screen no longer matches the cart
    const names = new Map((await getMenuItems(dropped.map((d) => d.itemId))).map((x) => [x.itemId, { name: x.name, name_en: x.nameEn }]));
    const removed = dropped.map((d) => ({ item_id: d.itemId, quantity: d.quantity, ...names.get(d.itemId) }));
    return { userText, cart, stale, data: { item, quantity: 1, added_to_cart: true, removed_from_previous_cart: removed, cart } };
  } catch (e) {
    if (!(e instanceof CommerceError)) throw e;
    return { userText, cart: null, stale: null, data: { item, quantity: 1, added_to_cart: false, error: { code: e.code, message: e.message }, cart: await getCart(userId) } };
  }
}

/** POST /api/agent/sessions/:id/messages → SSE stream of the agent's reply. */
agentRouter.post("/sessions/:id/messages", rateLimit("chat", 20, 60), asyncHandler(async (req, res) => {
  const user = req.user!;
  const session = await loadSession(req.params.id);
  if (!session || session.userId !== user.userId) return res.status(404).json({ code: "SESSION_NOT_FOUND" });
  const body = MessageBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: "INVALID_INPUT" });

  let input: TurnInput;
  let homeOrder: Awaited<ReturnType<typeof addHomeOrderItem>> = null;
  const ev = "event" in body.data ? body.data.event : null;
  if (ev?.type === "home_order") {
    homeOrder = await addHomeOrderItem(user.userId, ev.item_id, session.sessionExtraAllergens, session.locale);
    if (!homeOrder) return res.status(404).json({ code: "ITEM_NOT_FOUND" });
    input = { kind: "platform_event", event: "home_order", data: homeOrder.data };
  } else if (ev?.type === "checkout_result") {
    const outcome = await takeOutcomeForReport(ev.confirmation_request_id, user.userId, session.sessionId);
    if (!outcome) return res.status(409).json({ code: "NO_OUTCOME" });
    input = { kind: "platform_event", event: `checkout_${outcome.status}`, data: outcome };
  } else {
    const text = "text" in body.data ? body.data.text.trim() : "";
    // Empty first message = "start": the agent greets using the customer context.
    input = { kind: "user_message", text: text || (session.locale === "ja" ? "（会話開始）" : "(conversation start)") };
  }

  const sse = openSse(res);
  // Record what the customer sees, for chat history (one assistant entry per turn).
  const rec: { text: string; data: Record<string, unknown> } = { text: "", data: {} };
  const emit: Emit = (event, data) => {
    sse(event, data);
    const d = data as Record<string, unknown>;
    if (event === "text_delta") rec.text += String(d.text ?? "");
    else if (event === "item_cards") rec.data.item_cards = d.items;
    else if (event === "quick_replies") rec.data.quick_replies = d.options;
    else if (event === "confirmation_required") rec.data.confirmation_request_id = d.confirmation_request_id;
    else if (event === "error") rec.data.error = { code: d.code, message: d.message };
  };

  if (homeOrder) {
    // Shown as the customer's own message in the chat history; the mini cart updates before the agent replies.
    await appendTranscript(session.sessionId, user.userId, "user", homeOrder.userText);
    if (homeOrder.cart) sse("cart_updated", homeOrder.cart);
    if (homeOrder.stale) sse("confirmation_invalidated", { confirmation_request_id: homeOrder.stale, reason: "CART_CHANGED" });
  } else if (input.kind === "user_message" && body.data && "text" in body.data && body.data.text.trim()) {
    await appendTranscript(session.sessionId, user.userId, "user", body.data.text.trim());
  } else if (input.kind === "platform_event") {
    await appendTranscript(session.sessionId, user.userId, "event", input.event, input.data);
    if (input.data.status === "captured" && typeof input.data.order_id === "string") await setSessionOrder(session.sessionId, input.data.order_id);
  }
  try {
    await withSessionLock(session.sessionId, () => runAgentTurn(session, user, input, emit));
  } catch (e) {
    emit("error", { code: (e as Error).message === "SESSION_BUSY" ? "SESSION_BUSY" : "AGENT_ERROR" });
  } finally {
    // After a successful payment: show the order details (same content as the email) below the agent's message.
    if (input.kind === "platform_event" && input.data.status === "captured" && typeof input.data.order_id === "string") {
      const receipt = await orderReceipt(user.userId, input.data.order_id).catch(() => null);
      if (receipt) {
        sse("order_receipt", receipt);
        rec.data.order_receipt = receipt;
      }
    }
    if (rec.text || Object.keys(rec.data).length) {
      await appendTranscript(session.sessionId, user.userId, "assistant", rec.text || null, rec.data).catch((e) => console.error("[history]", e));
    }
    res.end();
  }
}));

/** GET /api/agent/sessions → the customer's past conversations (chat history). */
agentRouter.get("/sessions", asyncHandler(async (req, res) => {
  res.json({ sessions: await listSessions(req.user!.userId) });
}));

/** GET /api/agent/sessions/:id/transcript → messages of one conversation (to show it again and continue). */
agentRouter.get("/sessions/:id/transcript", asyncHandler(async (req, res) => {
  const t = await getTranscript(req.params.id, req.user!.userId);
  if (!t) return res.status(404).json({ code: "SESSION_NOT_FOUND" });
  res.json(t);
}));

/** POST /api/agent/feedback → post-delivery rating; preferences are learned with claude-haiku-5-5. */
agentRouter.post("/feedback", rateLimit("feedback", 10, 3600), asyncHandler(async (req, res) => {
  const body = z.object({ order_id: z.string(), stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: "INVALID_INPUT" });
  res.status(202).json({ ok: true });
  void learnFromReview(req.user!.userId, body.data.order_id, body.data.stars, body.data.comment).catch(() => undefined);
}));
