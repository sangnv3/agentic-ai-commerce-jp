import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from "@azure/msal-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

/**
 * Sign-in for the two backend modes (GET /api/auth/config):
 *  - entra: Microsoft Entra ID via MSAL (redirect flow), access token for the API scope
 *  - demo : shared demo password → short-lived token from POST /api/auth/demo-login
 * The Claude API key never reaches the browser; the app only holds the user's own access token.
 */
interface AuthConfig {
  mode: "entra" | "demo";
  entra: { clientId: string; tenantId: string; scope: string } | null;
}
interface AuthState {
  mode: "entra" | "demo";
  getToken: () => Promise<string>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);
const DEMO_KEY = "demo-session";

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

function readDemoSession(): string | null {
  try {
    const raw = sessionStorage.getItem(DEMO_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { token: string; exp: number };
    return s.exp > Date.now() + 60_000 ? s.token : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoToken, setDemoToken] = useState<string | null>(() => readDemoSession());
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const msal = useRef<PublicClientApplication | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/config");
        const cfg = (await res.json()) as AuthConfig;
        if (cfg.mode === "entra" && cfg.entra?.clientId) {
          const pca = new PublicClientApplication({
            auth: { clientId: cfg.entra.clientId, authority: `https://login.microsoftonline.com/${cfg.entra.tenantId}`, redirectUri: window.location.origin },
            cache: { cacheLocation: "sessionStorage" },
          });
          await pca.initialize();
          const redirect = await pca.handleRedirectPromise();
          const acc = redirect?.account ?? pca.getAllAccounts()[0] ?? null;
          msal.current = pca;
          if (!acc) {
            await pca.loginRedirect({ scopes: [cfg.entra.scope] });
            return;
          }
          setAccount(acc);
        }
        setConfig(cfg);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const tokenRef = useRef(demoToken);
  tokenRef.current = demoToken;

  const getToken = useCallback(async () => {
    if (config?.mode === "entra" && msal.current && account) {
      const scopes = [config.entra!.scope];
      try {
        return (await msal.current.acquireTokenSilent({ scopes, account })).accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) await msal.current.acquireTokenRedirect({ scopes, account });
        throw e;
      }
    }
    if (!tokenRef.current) throw new Error("not signed in");
    return tokenRef.current;
  }, [config, account]);

  const signOut = useCallback(() => {
    sessionStorage.removeItem(DEMO_KEY);
    setDemoToken(null);
    if (msal.current && account) void msal.current.logoutRedirect({ account });
  }, [account]);

  const value = useMemo<AuthState | null>(() => (config ? { mode: config.mode, getToken, signOut } : null), [config, getToken, signOut]);

  if (error) return <div className="center-card"><p role="alert">サーバーに接続できません / Cannot reach the server.</p><small>{error}</small></div>;
  if (!config) return <div className="center-card"><p>読み込み中…</p></div>;
  if (config.mode === "demo" && !demoToken) return <DemoLogin onToken={setDemoToken} />;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function DemoLogin({ onToken }: { onToken: (t: string) => void }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/auth/demo-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    setBusy(false);
    if (res.status === 429) return setMessage("試行回数が多すぎます。しばらくしてからお試しください。");
    if (!res.ok) return setMessage("パスワードが違います / Wrong password");
    const { token, expiresIn } = (await res.json()) as { token: string; expiresIn: number };
    sessionStorage.setItem(DEMO_KEY, JSON.stringify({ token, exp: Date.now() + expiresIn * 1000 }));
    onToken(token);
  }

  return (
    <div className="center-card">
      <h1>🍱 AIご注文アシスタント</h1>
      <p className="muted">デモ版：サンプル顧客「田中 健太」様としてログインします（えび・かにアレルギー登録済み）。決済はデモで、実際の請求は発生しません。</p>
      <form onSubmit={submit} className="login-form">
        <label>
          デモ用パスワード / Demo password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
        </label>
        <button type="submit" className="primary" disabled={busy}>{busy ? "…" : "ログイン / Sign in"}</button>
        {message && <p role="alert" className="error">{message}</p>}
      </form>
    </div>
  );
}
