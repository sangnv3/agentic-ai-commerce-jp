import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthProvider";
import { CartProvider, useCart } from "./cart";
import { CatalogProvider } from "./catalog";
import { AgentChat } from "./components/AgentChat";
import { CartPanel } from "./components/CartPanel";
import { OrdersPanel } from "./components/OrdersPanel";
import { HomePage } from "./components/HomePage";
import { HistoryPanel } from "./components/HistoryPanel";
import { PreferencesPanel } from "./components/PreferencesPanel";

type View = "home" | "chat" | "history" | "orders" | "preferences" | "cart";
const VIEWS: View[] = ["home", "chat", "history", "orders", "preferences", "cart"];
interface ChatTarget {
  key: number;
  resumeSessionId?: string;
  initialMessage?: string;
  orderItemId?: string;
}

/** Japanese by default on the first visit; English only if the visitor chose it before. */
function initialLocale(): "ja" | "en" {
  try {
    return localStorage.getItem("locale") === "en" ? "en" : "ja";
  } catch {
    return "ja";
  }
}

/**
 * The open tab lives in the URL path, so a reload (F5) or the browser's back button keeps the user where they were:
 * /orders, /history, /preferences, /cart, /chat, / = home. The open conversation's id is kept in sessionStorage
 * (per browser tab), so /chat reopens it after a reload without putting the id in the URL.
 * Both servers answer any non-/api path with the app (Vite's SPA fallback; the backend's catch-all in production).
 */
function parsePath(path: string): { view: View; sessionId?: string } {
  const [name, id] = path.replace(/^\/+/, "").split("/");
  const view = (VIEWS as string[]).includes(name) && name !== "home" ? (name as View) : "home";
  // Older links carried the id (/chat/cs_…): still honored, then the URL is shortened to /chat.
  return view === "chat" && id && /^cs_[\w-]{1,80}$/.test(id) ? { view, sessionId: id } : { view };
}
const pathFor = (view: View) => (view === "home" ? "/" : `/${view}`);

const CHAT_KEY = "chatSessionId";
function storedChat(): string | undefined {
  try {
    return sessionStorage.getItem(CHAT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function storeChat(id: string | null) {
  try {
    if (id) sessionStorage.setItem(CHAT_KEY, id);
    else sessionStorage.removeItem(CHAT_KEY);
  } catch {
    /* storage unavailable: the chat simply starts fresh after a reload */
  }
}

/** Old links used the hash (#/orders): move them to the path once, before the first render. */
function migrateHashUrl() {
  if (window.location.hash.startsWith("#/")) window.history.replaceState(null, "", window.location.hash.slice(1) || "/");
}

export function App() {
  const [locale, setLocale] = useState<"ja" | "en">(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("locale", locale);
    } catch {
      /* private mode */
    }
  }, [locale]);

  return (
    <CatalogProvider locale={locale}>
      <CartProvider>
        <Shell locale={locale} setLocale={setLocale} />
      </CartProvider>
    </CatalogProvider>
  );
}

function Shell({ locale, setLocale }: { locale: "ja" | "en"; setLocale: (l: "ja" | "en") => void }) {
  const { mode, signOut } = useAuth();
  const cart = useCart();
  const [start] = useState(() => {
    migrateHashUrl();
    const r = parsePath(window.location.pathname);
    return r.view === "chat" ? { ...r, sessionId: r.sessionId ?? storedChat() } : r;
  });
  const [view, setView] = useState<View>(start.view);
  // null until the first chat is opened; the chat stays mounted while browsing other tabs.
  const [chat, setChat] = useState<ChatTarget | null>(start.view === "chat" ? { key: 1, resumeSessionId: start.sessionId } : null);
  const [chatSessionId, setChatSessionId] = useState<string | null>(start.sessionId ?? null);

  const openChat = (target: Omit<ChatTarget, "key">) => {
    setChat((c) => ({ key: (c?.key ?? 0) + 1, ...target }));
    setChatSessionId(target.resumeSessionId ?? null);
    setView("chat");
  };
  const goToChat = () => (chat ? setView("chat") : openChat({}));
  // The chat restarts in the new language; drop the one-shot start request so it is not sent (or ordered) twice.
  const switchLocale = () => {
    setChat((c) => c && { key: c.key, resumeSessionId: c.resumeSessionId });
    setLocale(locale === "ja" ? "en" : "ja");
  };

  // The open conversation survives a reload of this tab (see storedChat).
  useEffect(() => {
    if (chatSessionId) storeChat(chatSessionId);
  }, [chatSessionId]);
  const signOutAndForget = () => {
    storeChat(null);
    signOut();
  };

  // view → URL. Shortening an old /chat/<id> link replaces the entry; any other change adds one (back button).
  useEffect(() => {
    const target = pathFor(view);
    if (window.location.pathname === target) return;
    const sameChat = view === "chat" && parsePath(window.location.pathname).view === "chat";
    if (sameChat) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
  }, [view]);

  // URL → view (browser back / forward).
  useEffect(() => {
    const onPopState = () => {
      const r = parsePath(window.location.pathname);
      setView(r.view);
      if (r.view === "chat" && !chat) openChat({ resumeSessionId: r.sessionId ?? storedChat() });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  const ja = locale === "ja";
  const tab = (v: View, label: string, onClick = () => setView(v)) => (
    <button type="button" className={view === v ? "tab active" : "tab"} aria-current={view === v ? "page" : undefined} onClick={onClick}>
      {label}
    </button>
  );
  const cartLabel = ja ? `カート（${cart.count}点）` : `Cart (${cart.count} item${cart.count === 1 ? "" : "s"})`;
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
          <button
            type="button"
            className={view === "cart" ? "cart-button active" : "cart-button"}
            aria-label={cartLabel}
            title={cartLabel}
            aria-current={view === "cart" ? "page" : undefined}
            onClick={() => setView("cart")}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="18" cy="20" r="1.5" />
              <path d="M2.5 3h2.6l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.1L21.5 7H6" />
            </svg>
            {cart.count > 0 && <span className="cart-button__badge">{cart.count > 99 ? "99+" : cart.count}</span>}
          </button>
          <button type="button" className="tab subtle" onClick={switchLocale} aria-label={ja ? "Switch to English" : "日本語に切り替え"}>
            {ja ? "EN" : "日本語"}
          </button>
          <button type="button" className="tab subtle" onClick={signOutAndForget}>{ja ? "ログアウト" : "Sign out"}</button>
        </div>
      </header>
      <main className={view !== "chat" ? "scroll" : undefined}>
        {view === "home" && (
          <HomePage
            locale={locale}
            onAskAgent={(message) => openChat({ initialMessage: message })}
            onOrderItem={(itemId) => openChat({ orderItemId: itemId })}
            onOpenPreferences={() => setView("preferences")}
          />
        )}
        {chat && (
          <div className="chat-host" hidden={view !== "chat"}>
            <AgentChat
              key={`${locale}-${chat.key}`}
              locale={locale}
              resumeSessionId={chat.resumeSessionId}
              initialMessage={chat.initialMessage}
              orderItemId={chat.orderItemId}
              onNewChat={() => openChat({})}
              onSessionReady={setChatSessionId}
              onResumeFailed={() => {
                storeChat(null);
                openChat({});
              }}
            />
          </div>
        )}
        {view === "history" && <HistoryPanel locale={locale} onOpen={(id) => openChat({ resumeSessionId: id })} />}
        {view === "orders" && <OrdersPanel locale={locale} />}
        {view === "preferences" && <PreferencesPanel locale={locale} onTryAgent={(message) => openChat({ initialMessage: message })} />}
        {view === "cart" && (
          <CartPanel
            locale={locale}
            onContinueShopping={() => setView("home")}
            onCheckout={() => openChat({ initialMessage: ja ? "カートの内容で注文します" : "I'd like to check out my cart" })}
          />
        )}
      </main>
    </div>
  );
}
