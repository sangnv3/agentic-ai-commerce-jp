import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { verifyDemoToken } from "./demo.js";
import { ensureUser, type AuthProvider } from "../commerce/customers.js";
import { redis } from "../checkout/confirmation.js";

/** Identity of the signed-in user. The agent only ever acts with this identity. */
export interface UserContext {
  userId: string; // internal users.user_id (UUID)
  externalId: string; // "entra:<oid>" | "demo:<id>" | "dev:<id>"
  provider: AuthProvider;
  scopes: string[];
  locale: "ja" | "en";
  /** Raw access token. Never sent to the LLM. */
  accessToken: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserContext;
    }
  }
}

const issuer = `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** externalId → users.user_id, cached in Redis for an hour. */
async function resolveUser(args: Parameters<typeof ensureUser>[0]): Promise<string> {
  const key = `user:ext:${args.externalId}`;
  const cached = await redis.get(key);
  if (cached) return cached;
  const userId = await ensureUser(args);
  await redis.set(key, userId, "EX", 3600);
  return userId;
}

const localeOf = (req: Request): "ja" | "en" => (String(req.header("accept-language") ?? "ja").startsWith("en") ? "en" : "ja");

export async function requireEntraUser(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ code: "UNAUTHENTICATED" });

    // LOCAL DEV ONLY: "Bearer dev:<name>" (config refuses DEV_MODE in production).
    if (config.devMode && token.startsWith("dev:")) {
      const externalId = token;
      req.user = { userId: await resolveUser({ externalId, provider: "dev" }), externalId, provider: "dev", scopes: ["Orders.ReadWrite"], locale: localeOf(req), accessToken: token };
      return next();
    }

    // Public demo deployment: tokens minted by POST /api/auth/demo-login (HS256, DEMO_AUTH_SECRET).
    if (config.authMode === "demo") {
      const demoId = await verifyDemoToken(token);
      if (!demoId) return res.status(401).json({ code: "INVALID_TOKEN" });
      const externalId = `demo:${demoId}`;
      req.user = { userId: await resolveUser({ externalId, provider: "demo" }), externalId, provider: "demo", scopes: ["Orders.ReadWrite"], locale: localeOf(req), accessToken: token };
      return next();
    }

    // Microsoft Entra ID access token for this API.
    if (!config.entra.tenantId) return res.status(500).json({ code: "ENTRA_NOT_CONFIGURED" });
    jwks ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.entra.tenantId}/discovery/v2.0/keys`));
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: config.entra.audience, algorithms: ["RS256"] });
    const scopes = String(payload.scp ?? "").split(" ").filter(Boolean);
    if (!scopes.includes("Orders.ReadWrite")) return res.status(403).json({ code: "INSUFFICIENT_SCOPE" });
    const oid = String(payload.oid);
    const externalId = `entra:${oid}`;
    req.user = {
      userId: await resolveUser({
        externalId,
        provider: "entra",
        entraOid: oid,
        entraTid: String(payload.tid),
        displayName: typeof payload.name === "string" ? payload.name : undefined,
        email: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
      }),
      externalId,
      provider: "entra",
      scopes,
      locale: localeOf(req),
      accessToken: token,
    };
    next();
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_JW")) return res.status(401).json({ code: "INVALID_TOKEN" });
    next(e);
  }
}
