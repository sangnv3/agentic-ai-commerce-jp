import { createHash, randomUUID } from "node:crypto";
import { db, tx } from "../db/pool.js";
import { redis, verifyConfirmationToken } from "../checkout/confirmation.js";
import { computeSummary, lockActiveCart, type CheckoutSummary } from "./cart.js";
import { getMenuItems } from "./catalog.js";
import { reserveSlot, slotStatus } from "./delivery.js";
import { CommerceError } from "./errors.js";
import { createPaymentGateway } from "./payments.js";
import { INVOICE_ISSUER } from "./settings.js";

const gateway = createPaymentGateway();
const jstYmd = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replace(/-/g, "");
const jstHHMM = (iso: string) => iso.slice(11, 16);

export type PaymentResult =
  | { status: "captured"; payment_id: string }
  | { status: "requires_action"; payment_id: string; redirect_url: string }
  | { status: "failed"; payment_id: string | null; code: string };

/**
 * execute_payment — only with a valid confirmation_token from the customer's button press.
 * Independently of the caller: verifies the token, locks the cart, re-checks version/hash/total, stock and slot,
 * then charges through the gateway with the same idempotency key.
 */
export async function capturePayment(userId: string, confirmationToken: string, idempotencyKey: string): Promise<PaymentResult> {
  const claims = await verifyConfirmationToken(confirmationToken).catch(() => {
    throw new CommerceError("INVALID_CONFIRMATION_TOKEN", "Confirmation token is invalid or expired");
  });
  if (claims.sub !== userId) throw new CommerceError("INVALID_CONFIRMATION_TOKEN", "Token belongs to another user");

  const existing = await db.query("SELECT payment_id, status, failure_code FROM payments WHERE idempotency_key = $1 AND user_id = $2", [idempotencyKey, userId]);
  if (existing.rows[0]) {
    const p = existing.rows[0];
    return p.status === "captured" ? { status: "captured", payment_id: p.payment_id } : { status: "failed", payment_id: p.payment_id, code: p.failure_code ?? "PAYMENT_FAILED" };
  }
  // Single-use token.
  if (!(await redis.set(`confirmation:jti:${claims.jti}`, "1", "EX", 3600, "NX"))) throw new CommerceError("TOKEN_ALREADY_USED", "Confirmation token was already used");

  return tx(async (c) => {
    const { cart, lines } = await lockActiveCart(c, userId);
    if (cart.cart_id !== claims.cart_id) throw new CommerceError("CONFIRMATION_STALE", "Cart changed after confirmation");
    const summary = await computeSummary(c, cart);
    if (summary.cart_version !== claims.cart_version || summary.checkout_hash !== claims.checkout_hash || summary.total !== claims.total) {
      throw new CommerceError("CONFIRMATION_STALE", "Cart changed after confirmation");
    }
    // Stock (locked) and slot re-check at the moment of payment.
    const stock = await c.query<{ item_id: string; daily_stock: number | null; is_sold_out: boolean; name_ja: string }>(
      "SELECT item_id, daily_stock, is_sold_out, name_ja FROM menu_items WHERE item_id = ANY($1) FOR UPDATE",
      [lines.map((l) => l.item_id)],
    );
    for (const l of lines) {
      const s = stock.rows.find((r) => r.item_id === l.item_id);
      if (!s || s.is_sold_out || (s.daily_stock !== null && s.daily_stock < l.quantity)) throw new CommerceError("ITEM_SOLD_OUT", `${s?.name_ja ?? l.item_id} is sold out`);
    }
    const slot = await slotStatus(summary.delivery_slot.start.slice(0, 10), jstHHMM(summary.delivery_slot.start), summary.zone);
    if (slot !== "available") throw new CommerceError(slot === "full" ? "SLOT_FULL" : "SLOT_UNAVAILABLE", `Delivery slot is ${slot}`);

    const pm = (await c.query("SELECT type, psp_token FROM payment_methods WHERE payment_method_id = $1 AND user_id = $2", [cart.payment_method_id, userId])).rows[0];
    const result = await gateway.charge({ amount: summary.total, method: { type: pm.type, pspToken: pm.psp_token }, idempotencyKey, description: `cart ${cart.cart_id}` });
    const paymentId = `pay_${randomUUID().slice(0, 12)}`;
    await c.query(
      `INSERT INTO payments (payment_id, user_id, cart_id, method_type, psp, psp_payment_id, idempotency_key, amount, status, failure_code, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, userId, cart.cart_id, pm.type, gateway.name, "pspPaymentId" in result ? result.pspPaymentId : null, idempotencyKey, summary.total, result.status, result.status === "failed" ? result.code : null, JSON.stringify(result)],
    );
    if (result.status === "captured") {
      for (const l of lines) await c.query("UPDATE menu_items SET daily_stock = daily_stock - $2 WHERE item_id = $1 AND daily_stock IS NOT NULL", [l.item_id, l.quantity]);
      // Freeze the paid cart; the next add_to_cart starts a new one.
      await c.query("UPDATE carts SET status = 'checked_out' WHERE cart_id = $1", [cart.cart_id]);
      return { status: "captured" as const, payment_id: paymentId };
    }
    if (result.status === "requires_action") return { status: "requires_action" as const, payment_id: paymentId, redirect_url: result.redirectUrl };
    return { status: "failed" as const, payment_id: paymentId, code: result.code };
  });
}

/** create_order — after a captured payment. Idempotent on the checkout key. */
export async function createOrder(userId: string, args: { paymentId: string; confirmationRequestId: string; idempotencyKey: string; placedVia: "agent_chat" | "ui" }) {
  const existing = await db.query<{ order_id: string }>("SELECT order_id FROM orders WHERE idempotency_key = $1", [args.idempotencyKey]);
  if (existing.rows[0]) return { order_id: existing.rows[0].order_id };

  return tx(async (c) => {
    const pay = (await c.query("SELECT * FROM payments WHERE payment_id = $1 AND user_id = $2 FOR UPDATE", [args.paymentId, userId])).rows[0];
    if (!pay || pay.status !== "captured") throw new CommerceError("PAYMENT_NOT_CAPTURED", "Payment is not captured");
    if (pay.order_id) return { order_id: pay.order_id as string };
    const cart = (await c.query("SELECT * FROM carts WHERE cart_id = $1 FOR UPDATE", [pay.cart_id])).rows[0];
    const summary: CheckoutSummary = await computeSummary(c, cart);
    const lines = (await c.query("SELECT * FROM cart_lines WHERE cart_id = $1 ORDER BY cart_line_id", [cart.cart_id])).rows;
    const items = await getMenuItems(lines.map((l) => l.item_id), c);
    const seq = (await c.query<{ n: string }>("SELECT nextval('order_number_seq') AS n")).rows[0].n;
    const orderId = `A-${jstYmd()}-${String(seq).padStart(4, "0")}`;
    const b8 = summary.tax_breakdown.find((b) => b.rate === 8);
    const b10 = summary.tax_breakdown.find((b) => b.rate === 10);
    const address = (await c.query("SELECT * FROM addresses WHERE address_id = $1", [cart.address_id])).rows[0];
    await c.query(
      `INSERT INTO orders (order_id, user_id, cart_id, restaurant_id, idempotency_key, confirmation_request_id, payment_id, status,
         delivery_slot_start, address_snapshot, subtotal_8, subtotal_10, tax_8, tax_10, discount_total, delivery_fee, total, placed_via, summary_snapshot, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())`,
      [orderId, userId, cart.cart_id, cart.restaurant_id, args.idempotencyKey, args.confirmationRequestId, args.paymentId, summary.delivery_slot.start,
        JSON.stringify(address), b8?.taxableAmountInclTax ?? 0, b10?.taxableAmountInclTax ?? 0, b8?.tax ?? 0, b10?.tax ?? 0,
        summary.discounts.reduce((s, d) => s - d.amount, 0), summary.delivery_fee, summary.total, args.placedVia, JSON.stringify(summary)],
    );
    for (const [i, l] of lines.entries()) {
      const m = items.find((x) => x.itemId === l.item_id)!;
      await c.query(
        `INSERT INTO order_lines (order_id, line_no, item_id, name_snapshot, options_snapshot, unit_price_incl_tax, quantity, tax_rate, allergens_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orderId, i + 1, l.item_id, m.name, JSON.stringify(l.options), l.unit_price_incl_tax, l.quantity, l.tax_category === "reduced_8" ? 8 : 10, m.allergens],
      );
    }
    await c.query("UPDATE payments SET order_id = $2, updated_at = now() WHERE payment_id = $1", [args.paymentId, orderId]);
    await reserveSlot(c, summary.zone, summary.delivery_slot.start);
    return { order_id: orderId };
  });
}

// ---------- 適格請求書 (Qualified Invoice) ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

function renderInvoice(number: string, orderId: string, s: CheckoutSummary, issuedAt: Date) {
  const rows = [
    ...s.lines.map((l) => `<tr><td>${esc(l.label)}${l.taxRate === 8 ? " ※" : ""}</td><td class="n">${l.quantity}</td><td class="n">${yen(l.amount)}</td></tr>`),
    ...s.discounts.map((d) => `<tr><td>${esc(d.label)}${d.taxRate === 8 ? " ※" : ""}</td><td></td><td class="n">-${yen(Math.abs(d.amount))}</td></tr>`),
    `<tr><td>配送料</td><td></td><td class="n">${yen(s.delivery_fee)}</td></tr>`,
  ].join("");
  const taxes = s.tax_breakdown.map((b) => `<tr><td>${b.rate}%対象</td><td class="n">${yen(b.taxableAmountInclTax)}</td><td class="n">内消費税 ${yen(b.tax)}</td></tr>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>適格請求書 ${esc(number)}</title>
<style>body{font-family:"Noto Sans JP",sans-serif;max-width:720px;margin:32px auto;color:#222}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:12px 0}
td{border-bottom:1px solid #ddd;padding:6px 4px}.n{text-align:right;white-space:nowrap}.total{font-size:18px;font-weight:700}.muted{color:#666;font-size:12px}</style></head>
<body><h1>適格請求書（領収書）</h1>
<p>請求書番号: ${esc(number)}<br>注文番号: ${esc(orderId)}<br>発行日: ${issuedAt.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
<p><strong>${esc(s.invoice_recipient ?? "")} 様</strong></p>
<p>発行者: ${esc(INVOICE_ISSUER.name)}<br>登録番号: ${esc(INVOICE_ISSUER.regNo)}</p>
<p>取引年月日: ${s.delivery_slot.start.slice(0, 10)}（お届け ${jstHHMM(s.delivery_slot.start)}〜${jstHHMM(s.delivery_slot.end)}）<br>お届け先: ${esc(s.address_text)}</p>
<table><tbody>${rows}</tbody></table>
<table><tbody>${taxes}</tbody></table>
<p class="total">合計（税込） ${yen(s.total)}</p>
<p class="muted">※は軽減税率（8%）対象 / お支払い: ${esc(s.payment_method.label)}</p></body></html>`;
}

/** create_invoice — idempotent per order (invoices.order_id UNIQUE). */
export async function createInvoice(orderId: string) {
  const prev = await db.query("SELECT invoice_id, invoice_number, document_html FROM invoices WHERE order_id = $1", [orderId]);
  if (prev.rows[0]) return { invoice_id: prev.rows[0].invoice_id as string, invoice_number: prev.rows[0].invoice_number as string, html: prev.rows[0].document_html as string };
  const o = (await db.query("SELECT * FROM orders WHERE order_id = $1", [orderId])).rows[0];
  if (!o) throw new CommerceError("NOT_FOUND", "order not found");
  const s = o.summary_snapshot as CheckoutSummary;
  const number = `INV-${orderId.slice(2)}`;
  const html = renderInvoice(number, orderId, s, new Date());
  const b8 = s.tax_breakdown.find((b) => b.rate === 8);
  const b10 = s.tax_breakdown.find((b) => b.rate === 10);
  await db.query(
    `INSERT INTO invoices (invoice_id, invoice_number, order_id, issuer_name, issuer_reg_no, recipient_name, transaction_date, lines,
       amount_8_incl, amount_10_incl, tax_8, tax_10, total, document_html, document_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (order_id) DO NOTHING`,
    [`inv_${orderId}`, number, orderId, INVOICE_ISSUER.name, INVOICE_ISSUER.regNo, s.invoice_recipient ?? "", s.delivery_slot.start.slice(0, 10),
      JSON.stringify([...s.lines, ...s.discounts]), b8?.taxableAmountInclTax ?? 0, b10?.taxableAmountInclTax ?? 0, b8?.tax ?? 0, b10?.tax ?? 0, s.total,
      html, createHash("sha256").update(html).digest("hex")],
  );
  return { invoice_id: `inv_${orderId}`, invoice_number: number, html };
}

export async function getInvoiceHtml(userId: string, orderId: string) {
  const { rows } = await db.query("SELECT i.document_html FROM invoices i JOIN orders o USING (order_id) WHERE i.order_id = $1 AND o.user_id = $2", [orderId, userId]);
  if (!rows[0]) throw new CommerceError("NOT_FOUND", "invoice not found");
  return rows[0].document_html as string;
}

export async function orderEmailView(orderId: string) {
  const o = (await db.query("SELECT o.*, u.email, u.display_name, u.locale FROM orders o JOIN users u USING (user_id) WHERE order_id = $1", [orderId])).rows[0];
  if (!o) throw new CommerceError("NOT_FOUND", "order not found");
  const s = o.summary_snapshot as CheckoutSummary;
  const lines = (await db.query("SELECT item_id, name_snapshot, quantity FROM order_lines WHERE order_id = $1 ORDER BY line_no", [orderId])).rows;
  const items = await getMenuItems(lines.map((l) => l.item_id));
  return {
    order_id: orderId,
    user_id: o.user_id as string,
    email: o.email as string | null,
    locale: (o.locale === "en" ? "en" : "ja") as "ja" | "en",
    customer_name: o.display_name as string,
    delivery_text: `${s.delivery_slot.start.slice(0, 10)} ${jstHHMM(s.delivery_slot.start)}〜${jstHHMM(s.delivery_slot.end)}`,
    address_text: s.address_text,
    total: s.total,
    items: lines.map((l) => {
      const m = items.find((x) => x.itemId === l.item_id);
      return { item_id: l.item_id, name: l.name_snapshot, restaurant_id: m?.restaurantId ?? "", tags: m?.tasteTags ?? [], quantity: l.quantity };
    }),
  };
}

/** Email dedupe: returns true only the first time for (order, template). */
export async function claimEmail(orderId: string, template: string, locale: string, to: string, invoiceId: string | null) {
  const r = await db.query(
    `INSERT INTO email_outbox (order_id, template, locale, to_address, attachment_invoice_id, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING email_id`,
    [orderId, template, locale, to, invoiceId, `email:${orderId}:${template}`],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function markEmailSent(orderId: string, template: string, providerMessageId: string) {
  await db.query("UPDATE email_outbox SET status = 'sent', provider_message_id = $3, attempts = attempts + 1 WHERE dedupe_key = $1 AND order_id = $2", [`email:${orderId}:${template}`, orderId, providerMessageId]);
}

export async function listOrders(userId: string) {
  const { rows } = await db.query(
    `SELECT order_id, status, total, delivery_slot_start, created_at, EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.order_id) AS has_invoice
       FROM orders o WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
  return rows;
}

/**
 * Order details shown in the chat right after payment — the same content as the confirmation email,
 * taken from the snapshot the customer confirmed (never re-written by the model).
 */
export async function orderReceipt(userId: string, orderId: string) {
  const o = (await db.query("SELECT o.*, u.email FROM orders o JOIN users u USING (user_id) WHERE o.order_id = $1 AND o.user_id = $2", [orderId, userId])).rows[0];
  if (!o) throw new CommerceError("NOT_FOUND", "order not found");
  const s = o.summary_snapshot as CheckoutSummary;
  return {
    order_id: orderId,
    placed_at: (o.created_at as Date).toISOString(),
    lines: s.lines,
    discounts: s.discounts,
    delivery_fee: s.delivery_fee,
    tax_breakdown: s.tax_breakdown,
    total: s.total,
    delivery_slot: s.delivery_slot,
    address_text: s.address_text,
    payment_label: s.payment_method.label,
    email: (o.email as string | null) ?? null,
  };
}
