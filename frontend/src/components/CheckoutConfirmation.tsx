import { useEffect, useMemo, useState } from "react";
import { readCsrfCookie, useApiFetch, yen } from "../api/client";

/**
 * HUMAN-IN-THE-LOOP confirmation screen.
 * - Renders the summary fetched from the server (never text produced by the model).
 * - The pay button is the ONLY way to trigger payment; it posts to /api/checkout/confirm.
 * - One Idempotency-Key per opened screen: double clicks / retries can never charge twice.
 */
interface Summary {
  cart_id: string;
  cart_version: number;
  total: number;
  lines: { label: string; quantity?: number; amount: number; taxRate: number }[];
  discounts: { label: string; amount: number; taxRate: number }[];
  delivery_fee: number;
  tax_breakdown: { rate: number; taxableAmountInclTax: number; tax: number }[];
  delivery_slot: { start: string; end: string };
  address_text: string;
  payment_method: { payment_method_id: string; label: string };
}

type Phase = "loading" | "ready" | "paying" | "requires_action" | "done" | "stale" | "failed" | "expired";

const T = {
  ja: {
    title: "ご注文内容の確認",
    delivery: "配送料",
    total: "合計（税込）",
    reduced: "※は軽減税率（8%）対象",
    taxLine: (rate: number, amt: number, tax: number) => `${rate}%対象 ${yen(amt)}（内消費税 ${yen(tax)}）`,
    when: "お届け日時",
    where: "お届け先",
    pay: "お支払い",
    change: "変更",
    edit: "内容を変更する",
    confirm: (total: number) => `🔒 確認して支払う ${yen(total)}`,
    paying: "処理中…",
    notice: "「確認して支払う」を押すと、上記の金額で決済されます。",
    stale: "内容が変更されました。最新の内容をチャットでご確認ください。",
    failed: "お支払いが完了しませんでした。ご請求は発生していません。",
    expired: "確認画面の有効期限が切れました。",
    done: (id: string) => `ご注文が確定しました。注文番号: ${id}`,
    expiresIn: "有効期限",
  },
  en: {
    title: "Confirm your order",
    delivery: "Delivery fee",
    total: "Total (tax incl.)",
    reduced: "※ reduced tax rate (8%)",
    taxLine: (rate: number, amt: number, tax: number) => `${rate}% items ${yen(amt)} (incl. tax ${yen(tax)})`,
    when: "Delivery time",
    where: "Address",
    pay: "Payment",
    change: "Change",
    edit: "Edit order",
    confirm: (total: number) => `🔒 Confirm & Pay ${yen(total)}`,
    paying: "Processing…",
    notice: "Pressing Confirm & Pay charges the amount above.",
    stale: "Your order changed. Please review the latest version in the chat.",
    failed: "Payment did not go through. You have not been charged.",
    expired: "This confirmation has expired.",
    done: (id: string) => `Order confirmed. Order number: ${id}`,
    expiresIn: "Expires in",
  },
};

export function CheckoutConfirmation(props: {
  confirmationRequestId: string;
  locale: "ja" | "en";
  onClose: () => void;
  onChangeRequested: (what: string) => void;
  /** Called once a definitive result exists (paid, failed, stale) so the agent can report / re-plan in chat. */
  onResult: (confirmationRequestId: string) => void;
}) {
  const L = T[props.locale];
  const apiFetch = useApiFetch();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [now, setNow] = useState(Date.now());
  const [phase, setPhase] = useState<Phase>("loading");
  const [armed, setArmed] = useState(false); // anti mis-click: enable the button shortly after render
  const [message, setMessage] = useState<string>("");
  // Generated once per opened screen, reused for every retry of this payment.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [props.confirmationRequestId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch(`/api/checkout/confirmation-requests/${props.confirmationRequestId}`);
      if (cancelled) return;
      if (!res.ok) return setPhase("stale");
      const body = (await res.json()) as { status: string; expires_at: string; summary: Summary };
      if (body.status !== "AWAITING_USER") return setPhase("stale");
      setSummary(body.summary);
      setExpiresAt(Date.parse(body.expires_at));
      setPhase("ready");
      setTimeout(() => !cancelled && setArmed(true), 1000);
    })();
    return () => {
      cancelled = true;
    };
  }, [apiFetch, props.confirmationRequestId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  useEffect(() => {
    if (phase === "ready" && expiresAt && remaining === 0) setPhase("expired");
  }, [phase, expiresAt, remaining]);

  async function confirmAndPay() {
    if (!summary || phase !== "ready" || !armed) return;
    setPhase("paying");
    const res = await apiFetch("/api/checkout/confirm", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey, "x-csrf-token": readCsrfCookie() },
      body: JSON.stringify({
        confirmation_request_id: props.confirmationRequestId,
        cart_version: summary.cart_version,
        displayed_total: summary.total,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; order_id?: string; redirect_url?: string; code?: string };

    if (res.status === 200 && body.status === "captured") {
      setPhase("done");
      setMessage(L.done(body.order_id ?? ""));
      setTimeout(() => props.onResult(props.confirmationRequestId), 1500);
    } else if (res.status === 202 && body.redirect_url) {
      setPhase("requires_action"); // PayPay / 3-D Secure — the return page reports the result to the agent
      window.location.assign(body.redirect_url);
    } else if (res.status === 409 && body.code === "IN_PROGRESS") {
      setPhase("paying");
    } else if (res.status === 409) {
      setPhase("stale");
      props.onResult(props.confirmationRequestId);
    } else {
      setPhase("failed");
      props.onResult(props.confirmationRequestId);
    }
  }

  const fmtSlot = (s: Summary["delivery_slot"]) => {
    const f = new Intl.DateTimeFormat(props.locale === "ja" ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const end = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(new Date(s.end));
    return `${f.format(new Date(s.start))}〜${end}`;
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="modal">
        <header>
          <h2 id="confirm-title">{L.title}</h2>
          <button type="button" aria-label="close" onClick={props.onClose} disabled={phase === "paying"}>✕</button>
        </header>

        {phase === "loading" && <p>…</p>}
        {phase === "stale" && <p role="alert">{L.stale}</p>}
        {phase === "expired" && <p role="alert">{L.expired}</p>}
        {phase === "failed" && <p role="alert">{L.failed}</p>}
        {phase === "done" && <p role="status">{message}</p>}

        {summary && (phase === "ready" || phase === "paying") && (
          <>
            <table className="summary">
              <tbody>
                {summary.lines.map((l, i) => (
                  <tr key={`l${i}`}><td>{l.label}{l.taxRate === 8 ? " ※" : ""}{l.quantity ? ` × ${l.quantity}` : ""}</td><td>{yen(l.amount)}</td></tr>
                ))}
                {summary.discounts.map((d, i) => (
                  <tr key={`d${i}`}><td>{d.label}{d.taxRate === 8 ? " ※" : ""}</td><td>−{yen(Math.abs(d.amount))}</td></tr>
                ))}
                <tr><td>{L.delivery}</td><td>{yen(summary.delivery_fee)}</td></tr>
              </tbody>
            </table>
            <ul className="tax-breakdown">
              {summary.tax_breakdown.map((b) => <li key={b.rate}>{L.taxLine(b.rate, b.taxableAmountInclTax, b.tax)}</li>)}
              <li>{L.reduced}</li>
            </ul>
            <p className="summary__total">{L.total} <strong>{yen(summary.total)}</strong></p>

            <dl className="summary__details">
              <dt>📅 {L.when}</dt><dd>{fmtSlot(summary.delivery_slot)} <button type="button" onClick={() => props.onChangeRequested(L.when)}>{L.change}</button></dd>
              <dt>📍 {L.where}</dt><dd>{summary.address_text} <button type="button" onClick={() => props.onChangeRequested(L.where)}>{L.change}</button></dd>
              <dt>💳 {L.pay}</dt><dd>{summary.payment_method.label} <button type="button" onClick={() => props.onChangeRequested(L.pay)}>{L.change}</button></dd>
            </dl>

            <p className="summary__expiry">⏱ {L.expiresIn}: {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</p>

            <footer>
              <button type="button" onClick={() => props.onChangeRequested(L.edit)} disabled={phase === "paying"}>{L.edit}</button>
              <button type="button" className="primary" onClick={confirmAndPay} disabled={!armed || phase === "paying"}>
                {phase === "paying" ? L.paying : L.confirm(summary.total)}
              </button>
            </footer>
            <small>{L.notice}</small>
          </>
        )}
      </div>
    </div>
  );
}
