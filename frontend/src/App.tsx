import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthProvider";
import { AgentChat } from "./components/AgentChat";
import { OrdersPanel } from "./components/OrdersPanel";
import { HomePage } from "./components/HomePage";
import { HistoryPanel } from "./components/HistoryPanel";

type View = "home" | "chat" | "history" | "orders";
interface ChatTarget {
  key: number;
  resumeSessionId?: string;
  initialMessage?: string;
}

export function App() {
  const { mode, signOut } = useAuth();
  const [locale, setLocale] = useState<"ja" | "en">(() => (localStorage.getItem("locale") === "en" ? "en" : "ja"));
  const [view, setView] = useState<View>("home");
  const [chat, setChat] = useState<ChatTarget>({ key: 0 });

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("locale", locale);
    } catch {
      /* private mode */
    }
  }, [locale]);

  const openChat = (target: Omit<ChatTarget, "key">) => {
    setChat((c) => ({ key: c.key + 1, ...target }));
    setView("chat");
  };

  const ja = locale === "ja";
  const tab = (v: View, label: string) => (
    <button type="button" className={view === v ? "tab active" : "tab"} onClick={() => setView(v)}>{label}</button>
  );
  return (
    <div className="app">
      {mode === "demo" && (
        <div className="demo-banner">{ja ? "デモ版 — 決済はシミュレーションです（実際の請求はありません）" : "Demo — payments are simulated (no real charges)"}</div>
      )}
      <header className="topbar">
        <button type="button" className="brand" onClick={() => setView("home")}>🍱 {ja ? "AIご注文アシスタント" : "AI Ordering Assistant"}</button>
        <nav>
          {tab("home", ja ? "ホーム" : "Home")}
          {tab("chat", ja ? "チャット" : "Chat")}
          {tab("history", ja ? "会話履歴" : "Chats")}
          {tab("orders", ja ? "注文履歴" : "Orders")}
          <button type="button" className="tab" onClick={() => openChat({})}>{ja ? "＋ 新しい会話" : "+ New chat"}</button>
          <button type="button" className="tab" onClick={() => setLocale(ja ? "en" : "ja")} aria-label="language">{ja ? "EN" : "日本語"}</button>
          <button type="button" className="tab" onClick={signOut}>{ja ? "ログアウト" : "Sign out"}</button>
        </nav>
      </header>
      <main className={view === "home" || view === "history" || view === "orders" ? "scroll" : undefined}>
        {view === "home" && <HomePage locale={locale} onAskAgent={(message) => openChat({ initialMessage: message })} />}
        {view === "chat" && (
          <AgentChat key={`${locale}-${chat.key}`} locale={locale} resumeSessionId={chat.resumeSessionId} initialMessage={chat.initialMessage} />
        )}
        {view === "history" && <HistoryPanel locale={locale} onOpen={(id) => openChat({ resumeSessionId: id })} />}
        {view === "orders" && <OrdersPanel locale={locale} />}
      </main>
    </div>
  );
}
