import { useCallback, useEffect, useRef, useState } from "react";
import { useApiFetch } from "../api/client";

export interface ItemCardData {
  item_id: string;
  name: string; // may contain <untrusted_data> wrapper from the agent service → stripped for display
  restaurant: { restaurant_id: string; name: string };
  price_incl_tax: number;
  allergens: string[];
  calories?: number;
  tags: string[];
  image_url?: string;
  match_reasons: string[];
}

export interface CartLine {
  id: string;
  quantity: number;
  lineTotal: number;
  item: { id: string; name: string };
  options?: Record<string, string>;
}
export interface CartState {
  id: string;
  version: number;
  subtotal: number;
  lines: CartLine[];
}

export type ChatEntry =
  | { kind: "assistant"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "cards"; id: string; items: ItemCardData[] }
  | { kind: "quick_replies"; id: string; options: { id: string; label: string }[] }
  | { kind: "note"; id: string; text: string }
  | { kind: "receipt"; id: string; receipt: OrderReceipt };

/** Order details shown after payment — same content as the confirmation email (from the server snapshot). */
export interface OrderReceipt {
  order_id: string;
  placed_at: string;
  lines: { label: string; quantity: number; amount: number; taxRate: number }[];
  discounts: { label: string; amount: number; taxRate: number }[];
  delivery_fee: number;
  tax_breakdown: { rate: number; taxableAmountInclTax: number; tax: number }[];
  total: number;
  delivery_slot: { start: string; end: string };
  address_text: string;
  payment_label: string;
  email: string | null;
}

/** One stored chat message (GET /api/agent/sessions/:id/transcript). */
export interface TranscriptMessage {
  message_id: number;
  role: "user" | "assistant" | "event";
  text: string | null;
  data: { order_receipt?: OrderReceipt; item_cards?: ItemCardData[]; quick_replies?: { id: string; label: string }[]; error?: { message?: string }; order_id?: string; code?: string; status?: string } | null;
  created_at: string;
}

export interface AgentStreamState {
  entries: ChatEntry[];
  cart: CartState | null;
  toolStatus: string | null;
  confirmationRequestId: string | null;
  streaming: boolean;
  /** Polite, localized message from the server (Claude unavailable, budget reached…) + link to the standard flow. */
  error: { code: string; message?: string; fallback_url?: string } | null;
  handoffSuggested: boolean;
}

/** Parse an SSE byte stream from a POST response (EventSource cannot POST). */
async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) as unknown };
    }
  }
}

let seq = 0;
const nextId = () => `e${++seq}`;

export function useAgentStream(sessionId: string | null) {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<AgentStreamState>({
    entries: [],
    cart: null,
    toolStatus: null,
    confirmationRequestId: null,
    streaming: false,
    error: null,
    handoffSuggested: false,
  });
  const busy = useRef(false);
  const last = useRef<{ text: string } | null>(null);
  const [lastFailed, setLastFailed] = useState(false);

  // Initial mini-cart state (an abandoned cart from an earlier visit is shown right away).
  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      const res = await apiFetch("/api/cart");
      if (res.ok) {
        const { cart } = (await res.json()) as { cart: CartState | null };
        if (cart?.lines.length) setState((s) => ({ ...s, cart: s.cart ?? cart }));
      }
    })();
  }, [sessionId, apiFetch]);

  /** Stream one agent turn. `payload` is either a chat text or a checkout-result event reference. */
  const run = useCallback(
    async (payload: { text: string } | { event: { type: "checkout_result"; confirmation_request_id: string } }) => {
      if (!sessionId || busy.current) return;
      busy.current = true;
      const assistantId = nextId();
      const text = "text" in payload ? payload.text : "";
      if ("text" in payload) last.current = payload;
      setLastFailed(false);
      setState((s) => ({
        ...s,
        streaming: true,
        error: null,
        entries: [
          ...s.entries,
          ...(text ? [{ kind: "user" as const, id: nextId(), text }] : []),
          { kind: "assistant" as const, id: assistantId, text: "" },
        ],
      }));

      try {
        const res = await apiFetch(`/api/agent/sessions/${sessionId}/messages`, {
          method: "POST",
          body: JSON.stringify("text" in payload ? { text, client_message_id: crypto.randomUUID() } : payload),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        for await (const { event, data } of readSse(res.body)) {
          setState((s) => reduce(s, event, data, assistantId));
        }
      } catch {
        setState((s) => ({ ...s, error: { code: "NETWORK" } }));
        setLastFailed(true);
      } finally {
        busy.current = false;
        setState((s) => ({ ...s, streaming: false, toolStatus: null }));
      }
    },
    [apiFetch, sessionId],
  );

  const send = useCallback((text: string) => run({ text }), [run]);
  /** Re-send the last chat message after a failure (polite error shown by the server or a network error). */
  const retry = useCallback(() => (last.current ? run(last.current) : undefined), [run]);
  /** After the button press: the agent reads the authoritative result server-side and reports it in chat. */
  const reportCheckout = useCallback(
    (confirmationRequestId: string) => run({ event: { type: "checkout_result", confirmation_request_id: confirmationRequestId } }),
    [run],
  );
  const closeConfirmation = useCallback(() => setState((s) => ({ ...s, confirmationRequestId: null })), []);

  /** Show a stored conversation (chat history) before continuing it. */
  const hydrate = useCallback((messages: TranscriptMessage[], locale: "ja" | "en") => {
    const entries: ChatEntry[] = [];
    for (const m of messages) {
      if (m.role === "user" && m.text) entries.push({ kind: "user", id: nextId(), text: m.text });
      if (m.role === "assistant") {
        const text = m.text || m.data?.error?.message || "";
        if (text) entries.push({ kind: "assistant", id: nextId(), text });
        if (m.data?.item_cards?.length) entries.push({ kind: "cards", id: nextId(), items: m.data.item_cards });
        if (m.data?.order_receipt) entries.push({ kind: "receipt", id: nextId(), receipt: m.data.order_receipt });
      }
      if (m.role === "event") {
        const ok = m.data?.status === "captured";
        if (ok) continue; // the assistant entry that follows carries the order details card
        entries.push({
          kind: "note",
          id: nextId(),
          text: ok
            ? (locale === "ja" ? `✅ 注文確定 ${m.data?.order_id ?? ""}` : `✅ Order placed ${m.data?.order_id ?? ""}`)
            : (locale === "ja" ? `⚠️ 決済されませんでした（${m.data?.code ?? m.text}）` : `⚠️ Not charged (${m.data?.code ?? m.text})`),
        });
      }
    }
    setState((s) => ({ ...s, entries }));
  }, []);

  return { ...state, send, reportCheckout, closeConfirmation, retry, hydrate, lastFailed: lastFailed || !!state.error };
}

function reduce(s: AgentStreamState, event: string, data: unknown, assistantId: string): AgentStreamState {
  const d = data as Record<string, unknown>;
  switch (event) {
    case "text_delta":
      return {
        ...s,
        entries: s.entries.map((e) => (e.id === assistantId && e.kind === "assistant" ? { ...e, text: e.text + String(d.text) } : e)),
      };
    case "tool_status":
      return { ...s, toolStatus: d.status === "running" ? String(d.tool) : null };
    case "order_receipt":
      return { ...s, cart: null, entries: [...s.entries, { kind: "receipt", id: nextId(), receipt: d as unknown as OrderReceipt }] };
    case "item_cards":
      return { ...s, entries: [...s.entries, { kind: "cards", id: nextId(), items: d.items as ItemCardData[] }] };
    case "quick_replies":
      return { ...s, entries: [...s.entries, { kind: "quick_replies", id: nextId(), options: d.options as { id: string; label: string }[] }] };
    case "cart_updated":
      return { ...s, cart: d as unknown as CartState };
    case "confirmation_required":
      return { ...s, confirmationRequestId: String(d.confirmation_request_id) };
    case "confirmation_invalidated":
      // The open confirmation screen re-fetches and shows "内容が変更されました".
      return s.confirmationRequestId === d.confirmation_request_id ? { ...s, confirmationRequestId: null } : s;
    case "error":
      return { ...s, error: d as AgentStreamState["error"] };
    case "handoff_suggested":
      return { ...s, handoffSuggested: true };
    default:
      return s;
  }
}
