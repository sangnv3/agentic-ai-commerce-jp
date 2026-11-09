import { useEffect, useState } from "react";
import { useApiFetch } from "../api/client";

interface SessionRow {
  session_id: string;
  title: string | null;
  started_at: string;
  last_activity_at: string;
  order_id: string | null;
  user_messages: number;
}

/** Chat history: past conversations, reopen one to read it and continue chatting. */
export function HistoryPanel({ locale, onOpen }: { locale: "ja" | "en"; onOpen: (sessionId: string) => void }) {
  const apiFetch = useApiFetch();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const ja = locale === "ja";

  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/agent/sessions");
      setRows(res.ok ? ((await res.json()) as { sessions: SessionRow[] }).sessions : []);
    })();
  }, [apiFetch]);

  if (!rows) return <p className="panel">…</p>;
  const visible = rows.filter((r) => r.user_messages > 0 || r.order_id);
  return (
    <section className="panel">
      <h2>{ja ? "会話履歴" : "Chat history"}</h2>
      {visible.length === 0 && <p className="muted">{ja ? "まだ会話はありません。" : "No conversations yet."}</p>}
      <ul className="orders">
        {visible.map((r) => (
          <li key={r.session_id}>
            <div>
              <strong>{r.title ?? (ja ? "（無題の会話）" : "(untitled)")}</strong>
              <div className="muted small">
                {new Date(r.last_activity_at).toLocaleString(ja ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" })}
                {" · "}
                {ja ? `${r.user_messages}件のメッセージ` : `${r.user_messages} messages`}
                {r.order_id && <> · ✅ {r.order_id}</>}
              </div>
            </div>
            <button type="button" onClick={() => onOpen(r.session_id)}>{ja ? "開く" : "Open"}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
