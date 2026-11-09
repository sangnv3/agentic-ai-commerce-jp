import { createHash, randomUUID } from "node:crypto";
import { db, tx, type Tx } from "../db/pool.js";
import { computeTax } from "../pricing/tax.js";
import { getMenuItem, getMenuItems, resolveOptions, type MenuItem } from "./catalog.js";
import { CommerceError } from "./errors.js";
import { COUPONS } from "./settings.js";
import { slotEndIso, slotIso, zoneForAddress } from "./delivery.js";
import { getPreferences } from "./customers.js";

interface CartRow {
  cart_id: string;
  user_id: string;
  restaurant_id: string | null;
  status: string;
  version: number;
  delivery_date: string | null;
  slot_start: Date | null;
  address_id: string | null;
  payment_method_id: string | null;
  coupon_code: string | null;
  invoice_recipient: string | null;
}
interface LineRow {
  cart_line_id: string;
  item_id: string;
  quantity: number;
  options: Record<string, string>;
  unit_price_incl_tax: number;
  tax_category: string;
  note: string | null;
  added_by: string;
}

/** Same limit as the cart screen and the agent's update_cart (quantity 1–20 per line). */
export const MAX_LINE_QUANTITY = 20;
const jstDate = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
const jstHHMM = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

/** The user's active cart, created on demand; locked FOR UPDATE when a transaction is given. */
async function activeCart(c: Tx, userId: string): Promise<CartRow> {
  const found = await c.query<CartRow>("SELECT * FROM carts WHERE user_id = $1 AND status = 'active' FOR UPDATE", [userId]);
  if (found.rows[0]) return found.rows[0];
  const pm = await c.query<{ payment_method_id: string }>("SELECT payment_method_id FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1", [userId]);
  const ins = await c.query<CartRow>(
    "INSERT INTO carts (user_id, created_by, payment_method_id) VALUES ($1, 'agent', $2) RETURNING *",
    [userId, pm.rows[0]?.payment_method_id ?? null],
  );
  return ins.rows[0];
}

async function lines(c: Tx | typeof db, cartId: string) {
  return (await c.query<LineRow>("SELECT * FROM cart_lines WHERE cart_id = $1 ORDER BY cart_line_id", [cartId])).rows;
}

async function bump(c: Tx, cart: CartRow) {
  const r = await c.query<{ version: number }>("UPDATE carts SET version = version + 1, last_activity_at = now() WHERE cart_id = $1 RETURNING version", [cart.cart_id]);
  cart.version = r.rows[0].version;
}

/** Cart shape used by the agent tools and the mini cart (SSE cart_updated). */
async function cartView(c: Tx | typeof db, cart: CartRow) {
  const ls = await lines(c, cart.cart_id);
  const items = await getMenuItems([...new Set(ls.map((l) => l.item_id))], c);
  const warnings = ls.flatMap((l) => {
    const m = items.find((i) => i.itemId === l.item_id);
    if (!m) return [{ code: "ITEM_REMOVED", message: "Item no longer available", lineId: l.cart_line_id }];
    if (m.isSoldOut) return [{ code: "ITEM_SOLD_OUT", message: `${m.name} is sold out`, lineId: l.cart_line_id }];
    return [];
  });
  return {
    id: cart.cart_id,
    version: cart.version,
    couponCode: cart.coupon_code,
    subtotal: ls.reduce((s, l) => s + l.unit_price_incl_tax * l.quantity, 0),
    deliverySlot: cart.slot_start ? { start: cart.slot_start.toISOString() } : null,
    addressId: cart.address_id,
    paymentMethodId: cart.payment_method_id,
    warnings,
    lines: ls.map((l) => ({
      id: l.cart_line_id,
      quantity: l.quantity,
      options: l.options,
      addedBy: l.added_by,
      unitPriceInclTax: l.unit_price_incl_tax,
      lineTotal: l.unit_price_incl_tax * l.quantity,
      item: { id: l.item_id, name: items.find((i) => i.itemId === l.item_id)?.name ?? l.item_id },
    })),
  };
}

function checkAllergens(m: MenuItem, optionAllergens: string[], forbidden: Set<string>, dietary: string[]) {
  const hit = [...m.allergens, ...optionAllergens].filter((a) => forbidden.has(a));
  if (hit.length) throw new CommerceError("ALLERGEN_CONFLICT", `${m.name} contains ${[...new Set(hit)].join(", ")}`);
  for (const d of dietary) if (!m.dietary.includes(d)) throw new CommerceError("DIETARY_CONFLICT", `${m.name} is not ${d}`);
}

async function constraints(userId: string, extraAllergens: string[]) {
  const p = await getPreferences(userId);
  return { forbidden: new Set([...p.hard_constraints.allergens, ...extraAllergens.map((a) => a.toLowerCase())]), dietary: p.hard_constraints.dietary };
}

function checkStock(m: MenuItem, quantity: number) {
  if (m.isSoldOut || (m.stock !== null && m.stock < quantity)) throw new CommerceError("ITEM_SOLD_OUT", `${m.name} is sold out`);
}

export async function getCart(userId: string) {
  const { rows } = await db.query<CartRow>("SELECT * FROM carts WHERE user_id = $1 AND status = 'active'", [userId]);
  return rows[0] ? cartView(db, rows[0]) : null;
}

/**
 * replaceCart: the item becomes the whole cart ("Order" on a home-page card = order this dish now). Earlier lines
 * and the coupon are dropped only after the stock/allergen checks pass, in the same transaction.
 * `onReplaced` receives the dropped lines (item ids) so the caller can tell the customer.
 */
export async function addToCart(
  userId: string,
  input: { itemId: string; quantity: number; options?: Record<string, string>; note?: string; addedBy?: string; replaceCart?: boolean },
  extraAllergens: string[] = [],
  onReplaced?: (dropped: { itemId: string; quantity: number }[]) => void,
) {
  const { forbidden, dietary } = await constraints(userId, extraAllergens);
  return tx(async (c) => {
    const cart = await activeCart(c, userId);
    const m = await getMenuItem(input.itemId, c);
    const opt = resolveOptions(m, input.options ?? {});
    checkStock(m, input.quantity);
    checkAllergens(m, opt.allergens, forbidden, dietary);
    let current = await lines(c, cart.cart_id);
    if (input.replaceCart && current.length) {
      await c.query("DELETE FROM cart_lines WHERE cart_id = $1", [cart.cart_id]);
      await c.query("UPDATE carts SET coupon_code = NULL WHERE cart_id = $1", [cart.cart_id]);
      cart.coupon_code = null;
      onReplaced?.(current.map((l) => ({ itemId: l.item_id, quantity: l.quantity })));
      current = [];
    }
    if (cart.restaurant_id && current.length && cart.restaurant_id !== m.restaurantId) {
      throw new CommerceError("DIFFERENT_RESTAURANT", "One order = one restaurant. Remove the current items first or choose from the same restaurant.");
    }
    // Same dish with the same options (and no special note) → one line with a higher quantity, not a second line.
    const key = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const same = input.note ? undefined : current.find((l) => l.item_id === m.itemId && !l.note && key(l.options) === key(opt.resolved));
    if (same) {
      const quantity = same.quantity + input.quantity;
      if (quantity > MAX_LINE_QUANTITY) throw new CommerceError("QUANTITY_LIMIT", `At most ${MAX_LINE_QUANTITY} of one dish per order`);
      checkStock(m, quantity);
      await c.query("UPDATE cart_lines SET quantity = $2 WHERE cart_line_id = $1", [same.cart_line_id, quantity]);
    } else {
      await c.query(
        `INSERT INTO cart_lines (cart_line_id, cart_id, item_id, quantity, options, unit_price_incl_tax, tax_category, note, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [`ln_${randomUUID().slice(0, 8)}`, cart.cart_id, m.itemId, input.quantity, JSON.stringify(opt.resolved), m.priceInclTax + opt.delta, m.taxCategory, input.note ?? null, input.addedBy ?? "agent"],
      );
    }
    await c.query("UPDATE carts SET restaurant_id = $2 WHERE cart_id = $1", [cart.cart_id, m.restaurantId]);
    await bump(c, cart);
    return cartView(c, cart);
  });
}

export interface CartOperation {
  op: "set_quantity" | "set_options" | "remove" | "replace";
  lineId: string;
  quantity?: number;
  options?: Record<string, string>;
  newItemId?: string;
}

export async function updateCart(userId: string, ops: CartOperation[], expectedVersion: number, extraAllergens: string[] = []) {
  const { forbidden, dietary } = await constraints(userId, extraAllergens);
  const removed: string[] = [];
  const view = await tx(async (c) => {
    const cart = await activeCart(c, userId);
    if (cart.version !== expectedVersion) throw new CommerceError("CART_VERSION_CONFLICT", `cart_version is ${cart.version}`);
    for (const op of ops) {
      const line = (await c.query<LineRow>("SELECT * FROM cart_lines WHERE cart_id = $1 AND cart_line_id = $2", [cart.cart_id, op.lineId])).rows[0];
      if (!line) throw new CommerceError("LINE_NOT_FOUND", `Cart line ${op.lineId} not found`);
      if (op.op === "remove") {
        await c.query("DELETE FROM cart_lines WHERE cart_line_id = $1", [line.cart_line_id]);
        removed.push(line.item_id);
      } else if (op.op === "set_quantity") {
        const m = await getMenuItem(line.item_id, c);
        checkStock(m, op.quantity ?? line.quantity);
        await c.query("UPDATE cart_lines SET quantity = $2 WHERE cart_line_id = $1", [line.cart_line_id, op.quantity ?? line.quantity]);
      } else if (op.op === "set_options") {
        const m = await getMenuItem(line.item_id, c);
        const opt = resolveOptions(m, { ...line.options, ...(op.options ?? {}) });
        checkAllergens(m, opt.allergens, forbidden, dietary);
        await c.query("UPDATE cart_lines SET options = $2, unit_price_incl_tax = $3 WHERE cart_line_id = $1", [line.cart_line_id, JSON.stringify(opt.resolved), m.priceInclTax + opt.delta]);
      } else if (op.op === "replace") {
        if (!op.newItemId) throw new CommerceError("INVALID_INPUT", "replace needs new_item_id");
        const m = await getMenuItem(op.newItemId, c);
        const opt = resolveOptions(m, op.options ?? {});
        checkStock(m, line.quantity);
        checkAllergens(m, opt.allergens, forbidden, dietary);
        await c.query(
          "UPDATE cart_lines SET item_id = $2, options = $3, unit_price_incl_tax = $4, tax_category = $5 WHERE cart_line_id = $1",
          [line.cart_line_id, m.itemId, JSON.stringify(opt.resolved), m.priceInclTax + opt.delta, m.taxCategory],
        );
        removed.push(line.item_id);
      }
    }
    // Keep the one-restaurant rule consistent after replacements.
    const restaurants = await c.query<{ restaurant_id: string }>(
      "SELECT DISTINCT m.restaurant_id FROM cart_lines l JOIN menu_items m USING (item_id) WHERE l.cart_id = $1",
      [cart.cart_id],
    );
    if (restaurants.rows.length > 1) throw new CommerceError("DIFFERENT_RESTAURANT", "One order = one restaurant.");
    await c.query("UPDATE carts SET restaurant_id = $2 WHERE cart_id = $1", [cart.cart_id, restaurants.rows[0]?.restaurant_id ?? null]);
    await bump(c, cart);
    return cartView(c, cart);
  });
  // Implicit preference signal: items taken out of the cart (weak, short half-life).
  for (const itemId of removed) {
    await db.query(
      `INSERT INTO preference_events (user_id, kind, subject_type, subject_id, value, source, half_life_days) VALUES ($1,'removed_from_cart','item',$2,-0.15,'system',14)`,
      [userId, itemId],
    );
  }
  return view;
}

function bestCoupon(subtotal: number, code?: string) {
  if (code) {
    const c = COUPONS[code.toUpperCase()];
    if (!c) throw new CommerceError("INVALID_COUPON", `Coupon ${code} does not exist`);
    if (subtotal < c.minSubtotal) throw new CommerceError("COUPON_NOT_ELIGIBLE", `Coupon ${code} needs a subtotal of ¥${c.minSubtotal}`);
    return code.toUpperCase();
  }
  const eligible = Object.entries(COUPONS).filter(([, c]) => subtotal >= c.minSubtotal).sort((a, b) => b[1].discount - a[1].discount);
  return eligible[0]?.[0] ?? null;
}

export async function applyCoupon(userId: string, args: { code?: string; auto?: boolean }) {
  return tx(async (c) => {
    const cart = await activeCart(c, userId);
    const subtotal = (await lines(c, cart.cart_id)).reduce((s, l) => s + l.unit_price_incl_tax * l.quantity, 0);
    const code = bestCoupon(subtotal, args.auto ? undefined : args.code);
    if (!code) throw new CommerceError("NO_ELIGIBLE_COUPON", "No coupon applies to this cart");
    if (cart.coupon_code !== code) {
      await c.query("UPDATE carts SET coupon_code = $2 WHERE cart_id = $1", [cart.cart_id, code]);
      cart.coupon_code = code;
      await bump(c, cart);
    }
    return { id: cart.cart_id, version: cart.version, subtotal, couponCode: code };
  });
}

/** Authoritative checkout summary (prices, discounts, delivery fee, tax per rate, total) + hash of what the user sees. */
export async function computeSummary(c: Tx | typeof db, cart: CartRow) {
  const ls = await lines(c, cart.cart_id);
  if (!ls.length) throw new CommerceError("CART_EMPTY", "Cart is empty");
  if (!cart.slot_start || !cart.address_id || !cart.delivery_date) throw new CommerceError("DELIVERY_NOT_SET", "Call prepare_checkout with delivery {date, slot_start, address_id} first");
  if (!cart.payment_method_id) throw new CommerceError("PAYMENT_METHOD_NOT_SET", "No payment method on file");
  const { address, zone } = await zoneForAddress(cart.user_id, cart.address_id);
  if (!zone) throw new CommerceError("OUT_OF_SERVICE_AREA", "Delivery address is outside the delivery area");
  const items = await getMenuItems([...new Set(ls.map((l) => l.item_id))], c);
  const summaryLines = ls.map((l) => {
    const m = items.find((i) => i.itemId === l.item_id)!;
    const opt = resolveOptions(m, l.options);
    // label (Japanese) is what the invoice prints; item_id + option_keys let the client show it in another language.
    return {
      label: opt.names.length ? `${m.name}（${opt.names.join("・")}）` : m.name, item_id: m.itemId, option_keys: opt.nameKeys,
      quantity: l.quantity, amount: l.unit_price_incl_tax * l.quantity, taxRate: l.tax_category === "reduced_8" ? 8 : 10,
    };
  });
  const subtotal = summaryLines.reduce((s, l) => s + l.amount, 0);
  const coupon = cart.coupon_code ? COUPONS[cart.coupon_code] : undefined;
  const discounts = coupon && subtotal >= coupon.minSubtotal ? [{ label: coupon.label, coupon_code: cart.coupon_code!, amount: -coupon.discount, taxRate: 8 }] : [];
  const tax = computeTax([...summaryLines, ...discounts, { amount: zone.fee, taxRate: 10 }].map((x) => ({ amountInclTax: x.amount, taxRate: x.taxRate as 8 | 10 })));
  const pm = (await c.query("SELECT * FROM payment_methods WHERE payment_method_id = $1", [cart.payment_method_id])).rows[0];
  const date = cart.delivery_date;
  const hhmm = jstHHMM(cart.slot_start);
  const recipient = cart.invoice_recipient ?? (await c.query<{ display_name: string }>("SELECT display_name FROM users WHERE user_id = $1", [cart.user_id])).rows[0]?.display_name;
  const body = {
    cart_id: cart.cart_id,
    cart_version: cart.version,
    total: tax.total,
    lines: summaryLines,
    discounts,
    delivery_fee: zone.fee,
    tax_breakdown: tax.buckets.map((b) => ({ rate: b.rate, taxableAmountInclTax: b.taxableAmountInclTax, tax: b.tax })),
    delivery_slot: { start: slotIso(date, hhmm), end: slotEndIso(date, hhmm) },
    address_text: `〒${address.postal_code.trim()} ${address.prefecture}${address.city}${address.street} ${address.building ?? ""}`.trim(),
    payment_method: { payment_method_id: pm.payment_method_id, label: pm.type === "card" ? `${pm.brand} **** ${pm.last4}` : pm.type === "paypay" ? "PayPay" : pm.type, type: pm.type },
    invoice_recipient: recipient,
    zone: zone.zone,
    currency: "JPY" as const,
  };
  return { ...body, checkout_hash: "sha256:" + createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export type CheckoutSummary = Awaited<ReturnType<typeof computeSummary>>;

/** Sets delivery / payment method / invoice recipient when given (bumping cart_version on change), then summarizes. */
export async function prepareCheckout(userId: string, args: { delivery?: { date: string; slotStart: string; addressId: string }; paymentMethodId?: string; recipient?: string } = {}) {
  return tx(async (c) => {
    const cart = await activeCart(c, userId);
    let changed = false;
    if (args.delivery) {
      await zoneForAddress(userId, args.delivery.addressId); // ownership check
      const start = new Date(slotIso(args.delivery.date, args.delivery.slotStart));
      if (cart.address_id !== args.delivery.addressId || cart.slot_start?.getTime() !== start.getTime()) {
        await c.query("UPDATE carts SET delivery_date = $2, slot_start = $3, address_id = $4 WHERE cart_id = $1", [cart.cart_id, args.delivery.date, start, args.delivery.addressId]);
        Object.assign(cart, { delivery_date: args.delivery.date, slot_start: start, address_id: args.delivery.addressId });
        changed = true;
      }
    }
    if (args.paymentMethodId && args.paymentMethodId !== cart.payment_method_id) {
      const pm = await c.query("SELECT 1 FROM payment_methods WHERE payment_method_id = $1 AND user_id = $2", [args.paymentMethodId, userId]);
      if (!pm.rowCount) throw new CommerceError("PAYMENT_METHOD_NOT_FOUND", `Payment method ${args.paymentMethodId} not found`);
      await c.query("UPDATE carts SET payment_method_id = $2 WHERE cart_id = $1", [cart.cart_id, args.paymentMethodId]);
      cart.payment_method_id = args.paymentMethodId;
      changed = true;
    }
    if (args.recipient && args.recipient !== cart.invoice_recipient) {
      await c.query("UPDATE carts SET invoice_recipient = $2 WHERE cart_id = $1", [cart.cart_id, args.recipient]);
      cart.invoice_recipient = args.recipient;
      changed = true;
    }
    if (changed) await bump(c, cart);
    // delivery_date may come back from pg as a Date: normalize to YYYY-MM-DD (JST)
    if (cart.delivery_date && typeof cart.delivery_date !== "string") cart.delivery_date = jstDate(cart.delivery_date as unknown as Date);
    return computeSummary(c, cart);
  });
}

/** Lock and summarize the active cart inside a payment transaction. */
export async function lockActiveCart(c: Tx, userId: string) {
  const cart = await activeCart(c, userId);
  if (cart.delivery_date && typeof cart.delivery_date !== "string") cart.delivery_date = jstDate(cart.delivery_date as unknown as Date);
  return { cart, lines: await lines(c, cart.cart_id) };
}
