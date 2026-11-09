/**
 * LOCAL DEV: chat with the agent in the terminal, including the human-in-the-loop payment step.
 *   npm run dev:chat            (agent service must be running: npm run dev)
 * Commands: /cart  /quit
 * When the agent opens the confirmation screen, the summary is printed and YOU decide (y/N) —
 * this simulates the "確認して支払う" button press (POST /api/checkout/confirm).
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const BASE = process.env.AGENT_URL ?? "http://localhost:8080";
const USER = process.env.DEV_USER ?? "u_tanaka";
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const LOCALE = process.env.DEV_LOCALE ?? "ja";
const CSRF = "dev-csrf-token";
const headers = {
  authorization: `Bearer dev:${USER}`,
  "content-type": "application/json",
  "accept-language": LOCALE,
  origin: ORIGIN,
  cookie: `csrf=${CSRF}`,
  "x-csrf-token": CSRF,
};
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const rl = createInterface({ input: stdin, output: stdout });

let pendingConfirmation: string | null = null;
type CartView = { version: number; subtotal: number; lines: { item: { name: string }; quantity: number; lineTotal: number }[] };
let lastCart = null as CartView | null;

async function stream(sessionId: string, body: unknown) {
  const res = await fetch(`${BASE}/api/agent/sessions/${sessionId}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    console.log(`\n[HTTP ${res.status}] ${await res.text()}`);
    return;
  }
  stdout.write(bold("\n🤖 "));
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
      if (!event || !dataLine) continue;
      const d = JSON.parse(dataLine);
      switch (event) {
        case "text_delta": stdout.write(d.text); break;
        case "tool_status": if (d.status === "running") stdout.write(dim(`\n   ⚙ ${d.tool}…\n`)); break;
        case "item_cards":
          stdout.write(dim(`\n   [thẻ món] ${d.items.map((x: { name: string; price_incl_tax: number }) => `${x.name.replace(/<\/?untrusted_data>/g, "")} ${yen(x.price_incl_tax)}`).join(" | ")}\n`));
          break;
        case "quick_replies": stdout.write(dim(`\n   [chip] ${d.options.map((o: { label: string }) => o.label).join(" · ")}\n`)); break;
        case "cart_updated": lastCart = d; stdout.write(dim(`\n   🛒 giỏ v${d.version}: ${d.lines.map((l: { item: { name: string }; quantity: number }) => `${l.item.name}×${l.quantity}`).join(", ")} = ${yen(d.subtotal)}\n`)); break;
        case "confirmation_required": pendingConfirmation = d.confirmation_request_id; break;
        case "confirmation_invalidated": if (pendingConfirmation === d.confirmation_request_id) pendingConfirmation = null; break;
        case "handoff_suggested": stdout.write(dim(`\n   ☎ gợi ý chuyển bộ phận hỗ trợ (${d.reason})\n`)); break;
        case "error": stdout.write(`\n⚠️  ${d.code}: ${d.message ?? ""}\n`); break;
      }
    }
  }
  stdout.write("\n");
}

async function confirmationStep(sessionId: string) {
  const id = pendingConfirmation!;
  pendingConfirmation = null;
  const r = await fetch(`${BASE}/api/checkout/confirmation-requests/${id}`, { headers });
  const { summary, status } = (await r.json()) as { status: string; summary: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (status !== "AWAITING_USER") return console.log(dim(`(confirmation ${id} is ${status})`));
  console.log(bold("\n┌─ MÀN HÌNH XÁC NHẬN (ご注文内容の確認) ─────────────────"));
  for (const l of summary.lines) console.log(`│ ${l.label}${l.taxRate === 8 ? " ※" : ""} × ${l.quantity}   ${yen(l.amount)}`);
  for (const d of summary.discounts) console.log(`│ ${d.label} ※   -${yen(Math.abs(d.amount))}`);
  console.log(`│ 配送料   ${yen(summary.delivery_fee)}`);
  for (const b of summary.tax_breakdown) console.log(`│ ${b.rate}%対象 ${yen(b.taxableAmountInclTax)}（内消費税 ${yen(b.tax)}）`);
  console.log(bold(`│ 合計（税込） ${yen(summary.total)}`));
  console.log(`│ お届け: ${summary.delivery_slot.start.slice(0, 16).replace("T", " ")}  ${summary.address_text}`);
  console.log(`│ お支払い: ${summary.payment_method.label}`);
  console.log(bold("└────────────────────────────────────────────────────"));
  const ans = (await rl.question(bold("Bấm nút 「確認して支払う」? [y/N] "))).trim().toLowerCase();
  if (ans !== "y") {
    await fetch(`${BASE}/api/checkout/confirmation-requests/${id}/cancel`, { method: "POST", headers });
    return console.log(dim("(không bấm — bạn có thể chat tiếp để đổi món/giờ/PTTT)"));
  }
  const res = await fetch(`${BASE}/api/checkout/confirm`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": randomUUID() },
    body: JSON.stringify({ confirmation_request_id: id, cart_version: summary.cart_version, displayed_total: summary.total }),
  });
  console.log(dim(`   → POST /api/checkout/confirm: HTTP ${res.status} ${await res.text()}`));
  // Same as the web UI: ask the agent to report the authoritative result.
  await stream(sessionId, { event: { type: "checkout_result", confirmation_request_id: id } });
}

const created = await fetch(`${BASE}/api/agent/sessions`, { method: "POST", headers, body: JSON.stringify({ locale: LOCALE }) });
if (!created.ok) {
  console.error(`Cannot create session: HTTP ${created.status} ${await created.text()}\nIs the agent service running (npm run dev) with DEV_MODE=true?`);
  process.exit(1);
}
const { session_id } = (await created.json()) as { session_id: string };
console.log(dim(`session ${session_id} · user ${USER} · /cart để xem giỏ · /quit để thoát`));
await stream(session_id, { text: "" }); // greeting

for (;;) {
  if (pendingConfirmation) await confirmationStep(session_id);
  const text = (await rl.question(bold("\n👤 "))).trim();
  if (text === "/quit") break;
  if (text === "/cart") {
    console.log(lastCart ? lastCart.lines.map((l) => `  ${l.item.name} × ${l.quantity}  ${yen(l.lineTotal)}`).join("\n") + `\n  = ${yen(lastCart.subtotal)}` : "  (giỏ trống)");
    continue;
  }
  if (text) await stream(session_id, { text });
}
rl.close();
