import { createHash } from "node:crypto";
import { db } from "../db/pool.js";

export interface AuditEntry {
  sessionId: string | null;
  userId: string;
  turnIndex?: number;
  actor: "llm" | "user_chat" | "user_ui" | "system";
  eventType:
    | "user_message"
    | "assistant_message"
    | "platform_event"
    | "intent"
    | "context_summarized"
    | "tool_call"
    | "tool_result"
    | "guardrail_block"
    | "confirmation_requested"
    | "confirmation_issued"
    | "payment_event"
    | "error";
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  cartVersionBefore?: number | null;
  cartVersionAfter?: number | null;
  decisionRationale?: string;
  model?: string;
  requestId?: string | null;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

const PII_KEYS = /^(email|phone|psp_token|card_number|access_token|confirmation_token)$/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, PII_KEYS.test(k) ? "[REDACTED]" : redact(v)]),
    );
  }
  return value;
}

/**
 * Append-only, hash-chained audit log (agent_logs). The DB role used here only has INSERT/SELECT.
 * The chain is per user: row_hash = sha256(prev_hash || canonical row).
 */
export async function audit(entry: AuditEntry): Promise<void> {
  const row = { ...entry, toolInput: redact(entry.toolInput), toolOutput: redact(entry.toolOutput) };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialize hash-chain writes per user.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [entry.userId]);
    const prev = await client.query<{ row_hash: string }>(
      "SELECT row_hash FROM agent_logs WHERE user_id = $1 ORDER BY log_id DESC LIMIT 1",
      [entry.userId],
    );
    const prevHash = prev.rows[0]?.row_hash ?? "GENESIS";
    const rowHash = createHash("sha256").update(prevHash).update(JSON.stringify(row)).digest("hex");
    await client.query(
      `INSERT INTO agent_logs (session_id, user_id, turn_index, actor, event_type, tool_name, tool_input, tool_output,
         cart_version_before, cart_version_after, decision_rationale, model, request_id, latency_ms,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        row.sessionId, row.userId, row.turnIndex ?? null, row.actor, row.eventType, row.toolName ?? null,
        JSON.stringify(row.toolInput ?? null), JSON.stringify(row.toolOutput ?? null),
        row.cartVersionBefore ?? null, row.cartVersionAfter ?? null, row.decisionRationale ?? null,
        row.model ?? null, row.requestId ?? null, row.latencyMs ?? null, row.inputTokens ?? null,
        row.outputTokens ?? null, row.cacheReadTokens ?? null, row.cacheWriteTokens ?? null, row.costUsd ?? null,
        prevHash, rowHash,
      ],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
