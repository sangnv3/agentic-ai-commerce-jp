import { useEffect, useState } from "react";
import { useApiFetch, yen } from "../api/client";

interface Order {
  order_id: string;
  status: string;
  total: number;
  delivery_slot_start: string;
  has_invoice: boolean;
}

/** Order history + qualified invoice viewer (HTML invoice fetched with the user's token, shown in a sandboxed iframe). */
export function OrdersPanel({ locale }: { locale: "ja" | "en" }) {
  const apiFetch = useApiFetch();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const ja = locale === "ja";

  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/orders");
      setOrders(res.ok ? ((await res.json()) as { orders: Order[] }).orders : []);
    })();
  }, [apiFetch]);

  async function openInvoice(orderId: string) {
    const res = await apiFetch(`/api/orders/${orderId}/invoice`);
    if (res.ok) setInvoice(await res.text());
  }

  if (!orders) return <p className="panel">…</p>;
  return (
    <section className="panel">
      <h2>{ja ? "注文履歴" : "Your orders"}</h2>
      {orders.length === 0 && <p className="muted">{ja ? "まだ注文はありません。" : "No orders yet."}</p>}
      <ul className="orders">
        {orders.map((o) => (
          <li key={o.order_id}>
            <div>
              <strong>{o.order_id}</strong>
              <span className="muted"> · {new Date(o.delivery_slot_start).toLocaleString(ja ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" })}</span>
            </div>
            <div>
              {yen(o.total)}{" "}
              {o.has_invoice && <button type="button" onClick={() => openInvoice(o.order_id)}>{ja ? "領収書" : "Invoice"}</button>}
            </div>
          </li>
        ))}
      </ul>
      {invoice && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setInvoice(null)}>
          <div className="modal invoice" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>{ja ? "適格請求書" : "Qualified invoice"}</h2>
              <button type="button" aria-label="close" onClick={() => setInvoice(null)}>✕</button>
            </header>
            <iframe title="invoice" sandbox="" srcDoc={invoice} />
          </div>
        </div>
      )}
    </section>
  );
}
