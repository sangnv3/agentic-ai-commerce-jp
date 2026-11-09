import { Router } from "express";
import { z } from "zod";
import { requireEntraUser } from "../auth/entra.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { getCart } from "../commerce/cart.js";
import { listMenuByCategory } from "../commerce/catalog.js";
import {
  CUISINES, DIETARY, TASTE_TAGS, deletePreferences, getPendingPreferenceChanges, getPreferences, getProfile, savePreferenceSettings,
} from "../commerce/customers.js";
import { ALLERGENS } from "../agent/tools.js";
import { getInvoiceHtml, listOrders } from "../commerce/orders.js";
import { CommerceError } from "../commerce/errors.js";

/** REST for the frontend: account, mini cart initial state, order history, invoices, APPI data controls. */
export const accountRouter = Router();
accountRouter.use(requireEntraUser);

accountRouter.get("/me", asyncHandler(async (req, res) => {
  const p = await getProfile(req.user!.userId);
  res.json({ displayName: p.displayName, addresses: p.addresses, paymentMethods: p.paymentMethods, provider: req.user!.provider });
}));

accountRouter.get("/menu", asyncHandler(async (_req, res) => {
  res.setHeader("cache-control", "private, max-age=60");
  res.json({ categories: await listMenuByCategory() });
}));

accountRouter.get("/cart", asyncHandler(async (req, res) => res.json({ cart: await getCart(req.user!.userId) })));

accountRouter.get("/orders", asyncHandler(async (req, res) => res.json({ orders: await listOrders(req.user!.userId) })));

accountRouter.get("/orders/:orderId/invoice", asyncHandler(async (req, res) => {
  try {
    const html = await getInvoiceHtml(req.user!.userId, req.params.orderId);
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
