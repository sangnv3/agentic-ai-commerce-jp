import { db } from "../db/pool.js";
import { audit } from "../audit/log.js";
import { extractPreferenceSignals } from "../agent/lightTasks.js";
import { charge } from "../llm/budget.js";
import { claimEmail, createInvoice, markEmailSent, orderEmailView } from "../commerce/orders.js";
import { savePreferenceSignals } from "../commerce/customers.js";
import { CommerceError } from "../commerce/errors.js";

/**
 * Post-order jobs (INTERNAL — not Claude tools): create_invoice → send_order_email → learn preferences.
 * They run in-process with retries; durability comes from the database: every step is idempotent
 * (invoices.order_id UNIQUE, email_outbox.dedupe_key UNIQUE) and resumePendingPostOrderJobs() re-runs anything
 * unfinished after a restart/redeploy. An email failure never affects the paid order.
 */
async function retry<T>(name: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= attempts) throw new Error(`${name} failed after ${attempts} attempts`, { cause: e });
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** i)));
    }
  }
}

// ---------- send_order_email ----------
export interface EmailAdapter {
  send(msg: { to: string; subject: string; text: string; html: string; attachment: { name: string; contentType: string; base64: string } }): Promise<string>;
}

/** Azure Communication Services Email. SendGrid can implement the same interface. */
export class AcsEmailAdapter implements EmailAdapter {
  async send(msg: Parameters<EmailAdapter["send"]>[0]): Promise<string> {
    const { EmailClient } = await import("@azure/communication-email");
    const client = new EmailClient(process.env.ACS_EMAIL_CONNECTION_STRING ?? "");
    const poller = await client.beginSend({
      senderAddress: process.env.ACS_EMAIL_SENDER ?? "DoNotReply@example.jp",
      recipients: { to: [{ address: msg.to }] },
      content: { subject: msg.subject, plainText: msg.text, html: msg.html },
      attachments: [{ name: msg.attachment.name, contentType: msg.attachment.contentType, contentInBase64: msg.attachment.base64 }],
    });
    const result = await poller.pollUntilDone();
    return result.id;
  }
}

/** Without ACS configured (local / demo): log the email instead of sending it. */
export class ConsoleEmailAdapter implements EmailAdapter {
  async send(msg: Parameters<EmailAdapter["send"]>[0]): Promise<string> {
    console.log(`\n📧 [email to ${msg.to}] ${msg.subject}\n${msg.text}\n   (attachment: ${msg.attachment.name})\n`);
    return `console-${Date.now()}`;
  }
}

const email: EmailAdapter = process.env.ACS_EMAIL_CONNECTION_STRING ? new AcsEmailAdapter() : new ConsoleEmailAdapter();

type OrderView = Awaited<ReturnType<typeof orderEmailView>>;

function renderOrderEmail(o: OrderView) {
  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
  if (o.locale === "en") {
    const text = `Dear ${o.customer_name},\n\nThank you for your order.\nOrder number: ${o.order_id}\nDelivery: ${o.delivery_text}\nAddress: ${o.address_text}\nTotal (tax incl.): ${yen(o.total)}\n\nYour qualified invoice is attached.`;
    return { subject: `[Order confirmed] ${o.order_id}`, text, html: `<pre>${text}</pre>` };
  }
  const text =
    `${o.customer_name} 様\n\nこの度はご注文いただき、誠にありがとうございます。\n` +
    `ご注文番号: ${o.order_id}\nお届け日時: ${o.delivery_text}\nお届け先: ${o.address_text}\n合計（税込）: ${yen(o.total)}\n\n` +
    `適格請求書（領収書）を添付しております。ご確認のほどよろしくお願いいたします。`;
  return { subject: `【ご注文確定】注文番号 ${o.order_id}`, text, html: `<pre style="font-family:'Noto Sans JP',sans-serif">${text}</pre>` };
}

async function sendOrderEmail(order: OrderView, invoice: { invoice_id: string; invoice_number: string; html: string }) {
  if (!order.email) return; // no address on file
  if (!(await claimEmail(order.order_id, "order_confirmed", order.locale, order.email, invoice.invoice_id))) return; // already sent
  const m = renderOrderEmail(order);
  const id = await email.send({
    to: order.email,
    ...m,
    attachment: { name: `${invoice.invoice_number}.html`, contentType: "text/html", base64: Buffer.from(invoice.html).toString("base64") },
  });
  await markEmailSent(order.order_id, "order_confirmed", id);
}

// ---------- preference learning (claude-haiku-5-5) ----------
async function learnFromOrder(order: OrderView, review?: { stars: number; comment?: string }) {
  const { output, usage } = await extractPreferenceSignals({ orderItems: order.items, stars: review?.stars, comment: review?.comment });
  await charge(order.user_id, usage);
  // Validated and capped in savePreferenceSignals. Allergy mentions are never applied automatically.
  await savePreferenceSignals(order.user_id, review ? "feedback" : "order", output.signals);
  if (output.possible_allergy_mention) {
    await audit({ sessionId: null, userId: order.user_id, actor: "system", eventType: "guardrail_block", toolName: "possible_allergy_mention", toolOutput: { order_id: order.order_id } });
  }
}

async function runPostOrder(orderId: string) {
  const order = await retry("load_order", () => orderEmailView(orderId));
  try {
    const invoice = await retry("create_invoice", () => createInvoice(orderId));
    await retry("send_order_email", () => sendOrderEmail(order, invoice));
    await retry("learn_from_order", () => learnFromOrder(order), 2);
  } catch (e) {
    await audit({ sessionId: null, userId: order.user_id, actor: "system", eventType: "error", toolName: "post_order_jobs", toolOutput: { order_id: orderId, error: String(e) } });
  }
}

export function enqueuePostOrderJobs(args: { orderId: string; userId: string }): void {
  setImmediate(() => void runPostOrder(args.orderId).catch((e) => console.error("[post-order]", e)));
}

/** On startup: finish invoices/emails of recent orders that were interrupted by a restart. */
export async function resumePendingPostOrderJobs(): Promise<void> {
  const { rows } = await db.query<{ order_id: string; user_id: string }>(
    `SELECT o.order_id, o.user_id FROM orders o
      WHERE o.created_at > now() - interval '2 days'
        AND (NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.order_id)
             OR NOT EXISTS (SELECT 1 FROM email_outbox e WHERE e.order_id = o.order_id AND e.status = 'sent'))`,
  );
  for (const r of rows) enqueuePostOrderJobs({ orderId: r.order_id, userId: r.user_id });
  if (rows.length) console.log(`[post-order] resumed ${rows.length} order(s)`);
}

/** Post-delivery rating flow (★1–5 + comment). */
export async function learnFromReview(userId: string, orderId: string, stars: number, comment?: string) {
  const order = await orderEmailView(orderId);
  if (order.user_id !== userId) throw new CommerceError("NOT_FOUND", "order not found");
  await learnFromOrder(order, { stars, comment });
}
