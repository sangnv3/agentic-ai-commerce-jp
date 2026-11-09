import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { Redis } from "ioredis";
import { SignJWT, importPKCS8, jwtVerify } from "jose";
import { config } from "../config.js";

/**
 * Human-in-the-loop gate.
 *
 *  LLM tool `request_payment_confirmation`  → createConfirmationRequest()   (status AWAITING_USER, NO token)
 *  UI button  POST /api/checkout/confirm    → issueConfirmationToken()      (verifies, mints single-use JWT)
 *  internal   execute_payment               → Commerce API verifies JWT again and consumes `jti`
 *
 * The token is never returned to the agent loop or placed in any LLM context.
 */
// family: 0 → resolve IPv4 and IPv6 (Railway private networking is IPv6-only).
export const redis = new Redis(config.redisUrl, { family: 0, maxRetriesPerRequest: 3 });

export interface CheckoutSummary {
  cart_id: string;
  cart_version: number;
  checkout_hash: string;
  total: number;
  currency: "JPY";
  payment_method: { payment_method_id: string; label: string };
  [k: string]: unknown;
}

export interface ConfirmationRequest {
  id: string;
  userId: string;
  sessionId: string;
  cartId: string;
  cartVersion: number;
  checkoutHash: string;
  total: number;
  paymentMethodId: string;
  summary: CheckoutSummary;
  status: "AWAITING_USER" | "TOKEN_ISSUED" | "CONSUMED" | "STALE" | "EXPIRED";
  expiresAt: number;
  /** Authoritative result of the button press, read by the agent turn that reports it (never sent by the client). */
  outcome?: Record<string, unknown> & { status: string };
  outcomeReported?: boolean;
}

export async function setOutcome(id: string, outcome: ConfirmationRequest["outcome"]): Promise<void> {
  const req = await getConfirmationRequest(id);
  if (!req) return;
  req.outcome = outcome;
  await redis.set(key(id), JSON.stringify(req), "KEEPTTL");
}

/** Returns the outcome once, so the agent reports each checkout result exactly one time. */
export async function takeOutcomeForReport(id: string, userId: string, sessionId: string) {
  const req = await getConfirmationRequest(id);
  if (!req || req.userId !== userId || req.sessionId !== sessionId || !req.outcome || req.outcomeReported) return null;
  req.outcomeReported = true;
  await redis.set(key(id), JSON.stringify(req), "KEEPTTL");
  return req.outcome;
}

const key = (id: string) => `confreq:${id}`;
const activeKey = (userId: string) => `confreq:active:${userId}`;

// checkout_hash is computed by the Commerce API in prepareCheckout: SHA-256 over the canonical JSON of
// everything the user will see (lines, options, prices, discounts, fee, tax, total, slot, address, method).

export async function createConfirmationRequest(
  userId: string,
  sessionId: string,
  summary: CheckoutSummary,
): Promise<ConfirmationRequest> {
  // Only one open confirmation per user: a new one makes the previous one stale.
  const prev = await redis.get(activeKey(userId));
  if (prev) await markStatus(prev, "STALE");

  const req: ConfirmationRequest = {
    id: `cr_${randomUUID()}`,
    userId,
    sessionId,
    cartId: summary.cart_id,
    cartVersion: summary.cart_version,
    checkoutHash: summary.checkout_hash,
    total: summary.total,
    paymentMethodId: summary.payment_method.payment_method_id,
    summary,
    status: "AWAITING_USER",
    expiresAt: Date.now() + config.confirmation.requestTtlSec * 1000,
  };
  await redis.set(key(req.id), JSON.stringify(req), "EX", config.confirmation.requestTtlSec + 60);
  await redis.set(activeKey(userId), req.id, "EX", config.confirmation.requestTtlSec + 60);
  return req;
}

export async function getConfirmationRequest(id: string): Promise<ConfirmationRequest | null> {
  const raw = await redis.get(key(id));
  return raw ? (JSON.parse(raw) as ConfirmationRequest) : null;
}

export async function markStatus(id: string, status: ConfirmationRequest["status"]): Promise<void> {
  const req = await getConfirmationRequest(id);
  if (!req) return;
  req.status = status;
  await redis.set(key(id), JSON.stringify(req), "KEEPTTL");
}

/** Called whenever the cart changes (cart_version bump) — invalidates open confirmations. */
export async function invalidateForUser(userId: string): Promise<string | null> {
  const id = await redis.get(activeKey(userId));
  if (!id) return null;
  const req = await getConfirmationRequest(id);
  if (req?.status === "AWAITING_USER") {
    await markStatus(id, "STALE");
    return id;
  }
  return null;
}

export class ConfirmationError extends Error {
  constructor(public code: "NOT_FOUND" | "FORBIDDEN" | "EXPIRED" | "CONFIRMATION_STALE" | "ALREADY_USED") {
    super(code);
  }
}

let signingKey: Awaited<ReturnType<typeof importPKCS8>> | undefined;
let verifyKey: KeyObject | undefined;
function signingPem() {
  const pem = config.confirmation.signingKeyPem || (config.confirmation.signingKeyFile ? readFileSync(config.confirmation.signingKeyFile, "utf8") : "");
  if (!pem) throw new Error("No confirmation signing key configured (CONFIRMATION_SIGNING_KEY_PEM / _FILE)");
  return pem;
}

export interface ConfirmationClaims {
  sub: string;
  jti: string;
  cart_id: string;
  cart_version: number;
  checkout_hash: string;
  total: number;
  payment_method_id: string;
  confirmation_request_id: string;
}

/** Verify a confirmation_token (signature, audience, issuer, expiry). Used by the payment module before charging. */
export async function verifyConfirmationToken(token: string): Promise<ConfirmationClaims> {
  verifyKey ??= createPublicKey(createPrivateKey(signingPem()));
  const { payload } = await jwtVerify(token, verifyKey, { audience: "payments", issuer: "agent-service/confirmation", algorithms: ["ES256"] });
  return payload as unknown as ConfirmationClaims;
}

async function getSigningKey() {
  const pem = signingPem();
  if (!pem) throw new Error("No confirmation signing key configured (CONFIRMATION_SIGNING_KEY_PEM / _FILE)");
  signingKey ??= await importPKCS8(pem, "ES256");
  return signingKey;
}

/**
 * Verify the button press against the stored request and the CURRENT cart state, then mint the token.
 * `currentCart` must be read fresh from the Commerce API by the caller.
 */
export async function issueConfirmationToken(args: {
  confirmationRequestId: string;
  userId: string;
  displayedCartVersion: number;
  displayedTotal: number;
  currentCart: { cart_version: number; checkout_hash: string; total: number };
}): Promise<{ token: string; request: ConfirmationRequest }> {
  const req = await getConfirmationRequest(args.confirmationRequestId);
  if (!req) throw new ConfirmationError("NOT_FOUND");
  if (req.userId !== args.userId) throw new ConfirmationError("FORBIDDEN");
  if (req.status === "TOKEN_ISSUED" || req.status === "CONSUMED") throw new ConfirmationError("ALREADY_USED");
  if (req.status !== "AWAITING_USER") throw new ConfirmationError("CONFIRMATION_STALE");
  if (Date.now() > req.expiresAt) {
    await markStatus(req.id, "EXPIRED");
    throw new ConfirmationError("EXPIRED");
  }
  const matches =
    args.displayedCartVersion === req.cartVersion &&
    args.displayedTotal === req.total &&
    args.currentCart.cart_version === req.cartVersion &&
    args.currentCart.checkout_hash === req.checkoutHash &&
    args.currentCart.total === req.total;
  if (!matches) {
    await markStatus(req.id, "STALE");
    throw new ConfirmationError("CONFIRMATION_STALE");
  }

  // Atomic claim: two concurrent button presses can both pass the checks above, but only one may mint a token.
  const claimed = await redis.set(`${key(req.id)}:token-claim`, "1", "EX", config.confirmation.requestTtlSec + 60, "NX");
  if (!claimed) throw new ConfirmationError("ALREADY_USED");

  const jti = randomUUID();
  const token = await new SignJWT({
    cart_id: req.cartId,
    cart_version: req.cartVersion,
    checkout_hash: req.checkoutHash,
    total: req.total,
    currency: "JPY",
    payment_method_id: req.paymentMethodId,
    confirmation_request_id: req.id,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject(req.userId)
    .setAudience("payments")
    .setIssuer("agent-service/confirmation")
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${config.confirmation.tokenTtlSec}s`)
    .sign(await getSigningKey());

  req.status = "TOKEN_ISSUED";
  await redis.set(key(req.id), JSON.stringify(req), "KEEPTTL");
  return { token, request: req };
}
