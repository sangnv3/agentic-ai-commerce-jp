import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { redis } from "../checkout/confirmation.js";
import { config } from "../config.js";

/**
 * Double-submit CSRF cookie: readable by the SPA (not HttpOnly), sent back as the X-CSRF-Token header on
 * POST /api/checkout/confirm. SameSite=Strict so other sites cannot make the browser send it.
 */
export function csrfCookie(req: Request, res: Response, next: NextFunction) {
  if (!/(?:^|;\s*)csrf=/.test(req.header("cookie") ?? "")) {
    const value = randomBytes(24).toString("base64url");
    res.append("set-cookie", `csrf=${value}; Path=/; SameSite=Strict${config.isProduction ? "; Secure" : ""}`);
  }
  next();
}

/** Fixed-window rate limit in Redis, keyed by user id when signed in, else by client IP. */
export function rateLimit(name: string, max: number, windowSec: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const who = req.user?.userId ?? req.ip ?? "unknown";
      const key = `ratelimit:${name}:${who}:${Math.floor(Date.now() / 1000 / windowSec)}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, windowSec);
      if (n > max) {
        res.setHeader("retry-after", String(windowSec));
        return res.status(429).json({ code: "RATE_LIMITED" });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Baseline security headers (the app and API share one origin). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://login.microsoftonline.com",
      "frame-src https://login.microsoftonline.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; "),
  );
  if (config.isProduction) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  next();
}
