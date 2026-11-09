import { Router } from "express";
import { requireEntraUser } from "../auth/entra.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { getCart } from "../commerce/cart.js";
import { listMenuByCategory } from "../commerce/catalog.js";
import { deletePreferences, getPreferences, getProfile } from "../commerce/customers.js";
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

// APPI: view and erase preference data.
accountRouter.get("/me/preferences", asyncHandler(async (req, res) => res.json(await getPreferences(req.user!.userId))));
accountRouter.delete("/me/preferences", asyncHandler(async (req, res) => {
  await deletePreferences(req.user!.userId);
  res.status(204).end();
}));
