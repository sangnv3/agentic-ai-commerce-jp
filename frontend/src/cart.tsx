import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApiFetch } from "./api/client";
import type { CartState } from "./hooks/useAgentStream";

interface CartContextValue {
  cart: CartState | null;
  /** Number of portions in the cart (menu badge). */
  count: number;
  /** Replace the shown cart (the chat pushes the agent's cart_updated events here). */
  setCart: (cart: CartState | null) => void;
  refresh: () => Promise<void>;
  /** replaceCart: empty a cart from another restaurant first (only after the customer agreed). */
  addItem: (itemId: string, opts?: { replaceCart?: boolean }) => Promise<CartEditResult>;
  setQuantity: (lineId: string, quantity: number) => Promise<CartEditResult>;
  removeLine: (lineId: string) => Promise<CartEditResult>;
  /** Bumped after each edit made on the cart screen (an open payment confirmation is then invalid). */
  uiEdits: number;
}
export type CartEditResult = { ok: true } | { ok: false; code: string };

const CartContext = createContext<CartContextValue | null>(null);

/** One cart shared by the menu badge, the cart screen and the chat's mini cart. */
export function CartProvider({ children }: { children: ReactNode }) {
  const apiFetch = useApiFetch();
  const [cart, setCart] = useState<CartState | null>(null);
  const [uiEdits, setUiEdits] = useState(0);

  const refresh = useCallback(async () => {
    const res = await apiFetch("/api/cart");
    if (res.ok) setCart(((await res.json()) as { cart: CartState | null }).cart);
  }, [apiFetch]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const edit = useCallback(
    async (lineId: string, method: "PATCH" | "DELETE", extra: Record<string, unknown> = {}): Promise<CartEditResult> => {
      if (!cart) return { ok: false, code: "CART_EMPTY" };
      const res = await apiFetch(`/api/cart/lines/${encodeURIComponent(lineId)}`, {
        method,
        body: JSON.stringify({ cart_version: cart.version, ...extra }),
      });
      const body = (await res.json().catch(() => ({}))) as { cart?: CartState | null; code?: string };
      if ("cart" in body) setCart(body.cart ?? null); // also on errors: show the server's current cart
      if (!res.ok) return { ok: false, code: body.code ?? `HTTP_${res.status}` };
      setUiEdits((n) => n + 1);
      return { ok: true };
    },
    [apiFetch, cart],
  );

  const addItem = useCallback(
    async (itemId: string, opts: { replaceCart?: boolean } = {}): Promise<CartEditResult> => {
      const res = await apiFetch("/api/cart/lines", {
        method: "POST",
        body: JSON.stringify({ item_id: itemId, quantity: 1, replace_cart: !!opts.replaceCart }),
      });
      const body = (await res.json().catch(() => ({}))) as { cart?: CartState | null; code?: string };
      if ("cart" in body) setCart(body.cart ?? null);
      if (!res.ok) return { ok: false, code: body.code ?? `HTTP_${res.status}` };
      setUiEdits((n) => n + 1);
      return { ok: true };
    },
    [apiFetch],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      count: cart?.lines.reduce((s, l) => s + l.quantity, 0) ?? 0,
      setCart,
      refresh,
      addItem,
      setQuantity: (lineId, quantity) => edit(lineId, "PATCH", { quantity }),
      removeLine: (lineId) => edit(lineId, "DELETE"),
      uiEdits,
    }),
    [cart, addItem, edit, refresh, uiEdits],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const c = useContext(CartContext);
  if (!c) throw new Error("useCart must be used inside <CartProvider>");
  return c;
}
