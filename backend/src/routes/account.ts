import { Router } from "express";
import { z } from "zod";
import { requireEntraUser } from "../auth/entra.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { addToCart, getCart, updateCart, type CartOperation } from "../commerce/cart.js";
import { invalidateForUser } from "../checkout/confirmation.js";
import { listMenuByCategory } from "../commerce/catalog.js";
import {
  CUISINES, DIETARY, TASTE_TAGS, deletePreferences, getPendingPreferenceChanges, getPreferences, getProfile, savePreferenceSettings,
} from "../commerce/customers.js";
import { ALLERGENS } from "../agent/tools.js";
import { getInvoiceHtml, listOrders } from "../commerce/orders.js";
import { CommerceError } from "../commerce/errors.js";
import { FX_JPY_PER_UNIT } from "../commerce/settings.js";

/** REST for the frontend: account, mini cart initial state, order history, invoices, APPI data controls. */
export const accountRouter = Router();
accountRouter.use(requireEntraUser);

accountRouter.get("/me", asyncHandler(async (req, res) => {
  const p = await getProfile(req.user!.userId);
  res.json({ displayName: p.displayName, addresses: p.addresses, paymentMethods: p.paymentMethods, provider: req.user!.provider });
}));

accountRouter.get("/menu", asyncHandler(async (_req, res) => {
  res.setHeader("cache-control", "private, max-age=60");
  // fx: approximate JPY per unit, for showing prices in the visitor's currency (payments stay in JPY).
  res.json({ ...(await listMenuByCategory()), fx: FX_JPY_PER_UNIT });
}));

accountRouter.get("/cart", asyncHandler(async (req, res) => res.json({ cart: await getCart(req.user!.userId) })));

// Cart screen: change a quantity or remove a line. Same rules as the agent's update_cart (stock, version check);
// an open payment confirmation no longer matches the cart, so it is invalidated. The agent sees the new cart
// on its next turn (<cart_state>).
const CartVersion = z.object({ cart_version: z.number().int().nonnegative() });
async function editCart(req: import("express").Request, res: import("express").Response, op: CartOperation, version: number) {
  const userId = req.user!.userId;
  try {
    const cart = await updateCart(userId, [op], version);
    await invalidateForUser(userId);
    res.json({ cart });
  } catch (e) {
    if (!(e instanceof CommerceError)) throw e;
    res.status(e.code === "CART_VERSION_CONFLICT" ? 409 : 400).json({ code: e.code, message: e.message, cart: await getCart(userId) });
  }
}
// "Add to cart" on a home-page card. replace_cart=true empties a cart from another restaurant first (after the
// customer agreed). Allergen / dietary / stock checks are the same as the agent's add_to_cart.
accountRouter.post("/cart/lines", asyncHandler(async (req, res) => {
  const body = z.object({
    item_id: z.string().regex(/^itm_[A-Za-z0-9_]{1,40}$/),
    quantity: z.number().int().min(1).max(20).default(1),
    replace_cart: z.boolean().default(false),
  }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: "INVALID_INPUT" });
  const userId = req.user!.userId;
  try {
    const cart = await addToCart(userId, { itemId: body.data.item_id, quantity: body.data.quantity, addedBy: "user", replaceCart: body.data.replace_cart });
    await invalidateForUser(userId);
    res.status(201).json({ cart });
  } catch (e) {
    if (!(e instanceof CommerceError)) throw e;
    res.status(e.code === "NOT_FOUND" ? 404 : 409).json({ code: e.code, message: e.message, cart: await getCart(userId) });
  }
}));

accountRouter.patch("/cart/lines/:lineId", asyncHandler(async (req, res) => {
  const body = CartVersion.extend({ quantity: z.number().int().min(1).max(20) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: "INVALID_INPUT" });
  await editCart(req, res, { op: "set_quantity", lineId: req.params.lineId, quantity: body.data.quantity }, body.data.cart_version);
}));
accountRouter.delete("/cart/lines/:lineId", asyncHandler(async (req, res) => {
  const body = CartVersion.strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: "INVALID_INPUT" });
  await editCart(req, res, { op: "remove", lineId: req.params.lineId }, body.data.cart_version);
}));

accountRouter.get("/orders", asyncHandler(async (req, res) => res.json({ orders: await listOrders(req.user!.userId) })));

accountRouter.get("/orders/:orderId/invoice", asyncHandler(async (req, res) => {
  try {
    const html = await getInvoiceHtml(req.user!.userId, req.params.orderId, req.query.lang === "en" ? "en" : "ja");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    res.send(html);
  } catch (e) {
    if (e instanceof CommerceError && e.code === "NOT_FOUND") return res.status(404).json({ code: "NOT_FOUND" });
    throw e;
  }
}));

// "My preferences" screen. Also the APPI view/erase controls for preference data.
const foodList = z.array(z.string().trim().min(1).max(40)).max(15).transform((a) => [...new Set(a)]);
const tagList = <T extends readonly [string, ...string[]]>(vals: T) => z.array(z.enum(vals)).max(vals.length).transform((a) => [...new Set(a)]);
const PreferenceSettingsSchema = z
  .object({
    allergens: tagList(ALLERGENS),
    dietary: tagList(DIETARY),
    stated: z
      .object({
        favorite_foods: foodList,
        avoid_foods: foodList,
        taste_like: tagList(TASTE_TAGS),
        taste_avoid: tagList(TASTE_TAGS),
        cuisines: tagList(CUISINES),
        budget_per_person: z.number().int().min(300).max(20000).nullable(),
        note: z.string().trim().max(300),
      })
      .strict()
      .refine((s) => !s.taste_like.some((t) => s.taste_avoid.includes(t)), { message: "a taste cannot be both liked and avoided" }),
  })
  .strict();

accountRouter.get("/me/preferences", asyncHandler(async (req, res) => {
  const [prefs, pending] = await Promise.all([getPreferences(req.user!.userId), getPendingPreferenceChanges(req.user!.userId)]);
  res.json({ ...prefs, pending_changes: pending });
}));
accountRouter.put("/me/preferences", asyncHandler(async (req, res) => {
  const parsed = PreferenceSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: "INVALID_INPUT", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  res.json(await savePreferenceSettings(req.user!.userId, parsed.data));
}));
accountRouter.delete("/me/preferences", asyncHandler(async (req, res) => {
  await deletePreferences(req.user!.userId);
  res.status(204).end();
}));
