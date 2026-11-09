import { randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

/**
 * Demo authentication for a public demo deployment (AUTH_MODE=demo).
 * One shared password; every login gets a fresh sample customer id (demo_<uuid>), so visitors never share
 * carts or orders. Payments in demo mode go to the demo Commerce API (no real money).
 */
const secret = () => new TextEncoder().encode(config.demo.secret);

export function checkDemoPassword(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.demo.password);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueDemoToken(): Promise<{ token: string; userId: string; expiresIn: number }> {
  const userId = `demo_${randomUUID().slice(0, 12)}`;
  const token = await new SignJWT({ scope: "Orders.ReadWrite" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("agent-service/demo")
    .setAudience("food-ordering-demo")
    .setIssuedAt()
    .setExpirationTime(`${config.demo.sessionTtlSec}s`)
    .sign(secret());
  return { token, userId, expiresIn: config.demo.sessionTtlSec };
}

export async function verifyDemoToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: "agent-service/demo", audience: "food-ordering-demo", algorithms: ["HS256"] });
    return typeof payload.sub === "string" && payload.sub.startsWith("demo_") ? payload.sub : null;
  } catch {
    return null;
  }
}
