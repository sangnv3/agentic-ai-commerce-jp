import { randomUUID } from "node:crypto";

/**
 * Payment gateway adapter. Replace DemoPaymentGateway with a real PSP adapter (GMO-PG, Stripe JP, PAY.JP…)
 * implementing the same interface; the idempotency key must be passed through to the PSP.
 */
export interface ChargeRequest {
  amount: number; // JPY
  method: { type: string; pspToken: string };
  idempotencyKey: string;
  description: string;
}
export type ChargeResult =
  | { status: "captured"; pspPaymentId: string }
  | { status: "requires_action"; pspPaymentId: string; redirectUrl: string }
  | { status: "failed"; code: string };

export interface PaymentGateway {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
}

/** No real money moves. Cards succeed; PayPay fails with INSUFFICIENT_BALANCE (to exercise the failure path). */
export class DemoPaymentGateway implements PaymentGateway {
  readonly name = "demo";
  private seen = new Map<string, ChargeResult>();
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const prev = this.seen.get(req.idempotencyKey);
    if (prev) return prev;
    const result: ChargeResult =
      req.method.type === "paypay" ? { status: "failed", code: "INSUFFICIENT_BALANCE" } : { status: "captured", pspPaymentId: `demo_${randomUUID().slice(0, 12)}` };
    this.seen.set(req.idempotencyKey, result);
    return result;
  }
}

export function createPaymentGateway(): PaymentGateway {
  const provider = process.env.PAYMENT_PROVIDER ?? "demo";
  if (provider === "demo") return new DemoPaymentGateway();
  throw new Error(`PAYMENT_PROVIDER=${provider} is not implemented yet (add an adapter in commerce/payments.ts)`);
}
