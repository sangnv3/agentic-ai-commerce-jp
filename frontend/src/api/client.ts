import { useCallback } from "react";
import { useAuth } from "../auth/AuthProvider";

/** fetch wrapper: same-origin /api, Bearer token of the signed-in user, CSRF cookie included. */
export function useApiFetch() {
  const { getToken } = useAuth();
  return useCallback(
    async (path: string, init: RequestInit = {}) => {
      const token = await getToken();
      return fetch(path, {
        ...init,
        credentials: "same-origin",
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "accept-language": document.documentElement.lang || "ja",
        },
      });
    },
    [getToken],
  );
}

export function readCsrfCookie(): string {
  return /(?:^|;\s*)csrf=([^;]+)/.exec(document.cookie)?.[1] ?? "";
}

export const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
