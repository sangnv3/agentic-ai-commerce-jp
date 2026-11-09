import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthProvider";
import { AgentChat } from "./components/AgentChat";
import { OrdersPanel } from "./components/OrdersPanel";
import { HomePage } from "./components/HomePage";
import { HistoryPanel } from "./components/HistoryPanel";
import { PreferencesPanel } from "./components/PreferencesPanel";

type View = "home" | "chat" | "history" | "orders" | "preferences";
interface ChatTarget {
  key: number;
  resumeSessionId?: string;
  initialMessage?: string;
}

/** Japanese by default on the first visit; English only if the visitor chose it before. */
function initialLocale(): "ja" | "en" {
  try {
    return localStorage.getItem("locale") === "en" ? "en" : "ja";
  } catch {
    return "ja";
  }
}

export function App() {
  const { mode, signOut } = useAuth();
  const [locale, setLocale] = useState<"ja" | "en">(initialLocale);
  const [view, setView] = useState<View>("home");
  // null until the first chat is opened; the chat stays mounted while browsing other tabs.
  const [chat, setChat] = useState<ChatTarget | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("locale", locale);
    } catch {
      /* private mode */
    }
  }, [locale]);

  const openChat = (target: Omit<ChatTarget, "key">) => {
    setChat((c) => ({ key: (c?.key ?? 0) + 1, ...target }));
    setView("chat");
  };
  const goToChat = () => (chat ? setView("chat") : openChat({}));

  const ja = locale === "ja";
  const tab = (v: View, label: string, onClick = () => setView(v)) => (
    <button type="button" className={view === v ? "tab active" : "tab"} aria-current={view === v ? "page" : undefined} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div className="app">
      {mode === "demo" && (
        <div className="demo-banner">{ja ? "デモ版 — 決済はシミュレーションです（実際の請求はありません）" : "Demo — payments are simulated (no real charges)"}</div>
      )}
      <header className="topbar">
        <button type="button" className="brand" onClick={() => setView("home")}>🍱 {ja ? "AIご注文アシスタント" : "AI Ordering Assistant"}</button>
        <nav className="mainnav" aria-label={ja ? "メニュー" : "Menu"}>
          {tab("home", ja ? "ホーム" : "Home")}
          {tab("chat", ja ? "🤖 AIアシスタントとチャット" : "🤖 Chat with AI Ordering Assistant", goToChat)}
          {tab("history", ja ? "会話履歴" : "Chat History")}
          {tab("orders", ja ? "注文履歴" : "Orders")}
          {tab("preferences", ja ? "好みの設定" : "Preferences")}
        </nav>
        <div className="topbar__right">
          <button type="button" className="tab subtle" onClick={() => setLocale(ja ? "en" : "ja")} aria-label={ja ? "Switch to English" : "日本語に切り替え"}>
            {ja ? "EN" : "日本語"}
          </button>
          <button type="button" className="tab subtle" onClick={signOut}>{ja ? "ログアウト" : "Sign out"}</button>
        </div>
      </header>
      <main className={view !== "chat" ? "scroll" : undefined}>
        {view === "home" && (
          <HomePage locale={locale} onAskAgent={(message) => openChat({ initialMessage: message })} onOpenPreferences={() => setView("preferences")} />
        )}
        {chat && (
          <div className="chat-host" hidden={view !== "chat"}>
            <AgentChat
              key={`${locale}-${chat.key}`}
              locale={locale}
              resumeSessionId={chat.resumeSessionId}
              initialMessage={chat.initialMessage}
              onNewChat={() => openChat({})}
            />
          </div>
        )}
        {view === "history" && <HistoryPanel locale={locale} onOpen={(id) => openChat({ resumeSessionId: id })} />}
        {view === "orders" && <OrdersPanel locale={locale} />}
        {view === "preferences" && <PreferencesPanel locale={locale} onTryAgent={(message) => openChat({ initialMessage: message })} />}
      </main>
    </div>
  );
}
