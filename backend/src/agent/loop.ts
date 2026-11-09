import { config } from "../config.js";
import type { UserContext } from "../auth/entra.js";
import { audit } from "../audit/log.js";
import { llm } from "../llm/anthropicProvider.js";
import { charge, hasBudget } from "../llm/budget.js";
import { LLMConfigError, LLMRefusalError, LLMUnavailableError, type Message } from "../llm/provider.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { LLM_TOOLS, executeTool, makeToolContext } from "./tools.js";
import { sanitizeUserChat } from "./sanitize.js";
import { contextBlocksForTurn, maybeSummarize } from "./context.js";
import { classifyIntent } from "./lightTasks.js";
import { saveSession, type AgentSession } from "./sessionStore.js";
import { getCart } from "../commerce/cart.js";

export type Emit = (event: string, data: unknown) => void;

/** What starts a turn: a customer message, or a platform event (checkout result, cart edited in the UI…). */
export type TurnInput =
  | { kind: "user_message"; text: string }
  | { kind: "platform_event"; event: string; data: Record<string, unknown> };

const UNAVAILABLE = {
  ja: "申し訳ございません。ただいまアシスタントが混み合っており、ご応答できません。カートの内容は保存されています。少し時間をおいて再度お試しください。",
  en: "Sorry, the assistant is busy right now. Your cart has been saved. Please try again in a moment.",
};
const BUDGET_EXCEEDED = {
  ja: "本日のアシスタントのご利用上限に達しました。カートはそのまま保存されています。明日またご利用ください。",
  en: "You have reached today's assistant limit. Your cart is saved — please come back tomorrow.",
};

/**
 * One chat turn — the agent loop:
 *   Claude thinks & plans → requests tools → backend validates and executes with the user's rights
 *   → Claude observes the results and adjusts → … → Claude answers (streamed).
 */
export async function runAgentTurn(session: AgentSession, user: UserContext, input: TurnInput, emit: Emit): Promise<void> {
  const deadline = AbortSignal.timeout(config.llm.turnTimeoutMs);

  if (!(await hasBudget(user.userId))) {
    emit("error", { code: "BUDGET_EXCEEDED", message: BUDGET_EXCEEDED[session.locale] });
    emit("message_end", { turn: session.turnIndex });
    return;
  }

  // Context management: summarize into a new epoch if the conversation has grown too large.
  if (await maybeSummarize(session)) {
    await audit({ sessionId: session.sessionId, userId: user.userId, actor: "system", eventType: "context_summarized", toolOutput: { epoch: session.epoch } });
  }

  const ctxAllergens = new Set(session.sessionExtraAllergens);
  const toolCtx = makeToolContext(user, session.sessionId, ctxAllergens, emit);
  const messages: Message[] = session.messages;
  session.turnIndex += 1;
  const contextBlocks = await contextBlocksForTurn(session, user);

  if (input.kind === "user_message") {
    const text = sanitizeUserChat(input.text);
    messages.push({ role: "user", content: [...contextBlocks.map((t) => ({ type: "text" as const, text: t })), { type: "text", text }] });
    await audit({ sessionId: session.sessionId, userId: user.userId, turnIndex: session.turnIndex, actor: "user_chat", eventType: "user_message", toolOutput: { text } });
    // Light model, in parallel and non-blocking: intent for routing (e.g. complaints → human support) and analytics.
    void classifyIntent(text)
      .then(async ({ output, usage }) => {
        await charge(user.userId, usage);
        if (output.needs_human_support) emit("handoff_suggested", { reason: output.intent });
        await audit({ sessionId: session.sessionId, userId: user.userId, turnIndex: session.turnIndex, actor: "system", eventType: "intent", toolOutput: output, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
      })
      .catch(() => undefined);
  } else {
    // Platform events use the operator channel — a mid-conversation system message after a user turn — so a customer
    // typing "payment_succeeded" can never impersonate one.
    messages.push({ role: "user", content: contextBlocks.map((t) => ({ type: "text" as const, text: t })) });
    messages.push({ role: "system", content: `Platform event: ${input.event} ${JSON.stringify(input.data)}` } as unknown as Message);
    await audit({ sessionId: session.sessionId, userId: user.userId, turnIndex: session.turnIndex, actor: "system", eventType: "platform_event", toolOutput: input });
  }

  let toolCalls = 0;
  try {
    for (let iter = 0; iter < config.limits.maxIterationsPerTurn; iter++) {
      // ── 1–2. Claude thinks, plans and decides which tools to call (streamed) ──
      const turn = await llm.agentTurn({
        system: SYSTEM_PROMPT,
        tools: LLM_TOOLS,
        messages,
        onText: (delta) => emit("text_delta", { text: delta }),
        signal: deadline,
      });
      // Append verbatim (thinking blocks included): history stays append-only.
      messages.push({ role: "assistant", content: turn.content });
      session.lastInputTokens = turn.usage.inputTokens + turn.usage.cacheReadTokens + turn.usage.cacheWriteTokens;
      session.totals.inputTokens += session.lastInputTokens;
      session.totals.outputTokens += turn.usage.outputTokens;
      session.totals.costUsd += turn.usage.costUsd;
      await charge(user.userId, turn.usage, iter === 0);

      await audit({
        sessionId: session.sessionId,
        userId: user.userId,
        turnIndex: session.turnIndex,
        actor: "llm",
        eventType: "assistant_message",
        toolOutput: {
          stop_reason: turn.stopReason,
          text: turn.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""),
          planned_tools: turn.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name),
        },
        // Readable reasoning summaries — Claude's "thinking" for the audit trail (raw chain of thought is never exposed).
        decisionRationale: turn.thinkingSummaries.join("\n---\n") || undefined,
        model: turn.usage.model,
        requestId: turn.requestId,
        latencyMs: turn.latencyMs,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cacheReadTokens: turn.usage.cacheReadTokens,
        cacheWriteTokens: turn.usage.cacheWriteTokens,
        costUsd: turn.usage.costUsd,
      });

      if (turn.stopReason === "max_tokens") throw new LLMUnavailableError("server_error");
      if (turn.stopReason === "pause_turn") continue;

      const toolUses = turn.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
      if (turn.stopReason !== "tool_use" || toolUses.length === 0) break; // ── 5. final answer streamed ──

      toolCalls += toolUses.length;
      if (toolCalls > config.limits.maxToolCallsPerTurn) {
        messages.push({
          role: "user",
          content: toolUses.map((t) => ({ type: "tool_result" as const, tool_use_id: t.id, is_error: true, content: "Tool call limit reached for this turn. Answer the customer now with what you have." })),
        });
        continue;
      }

      // ── 3. Backend executes (validated, with the user's identity), all calls of this step in parallel ──
      const results = await Promise.all(
        toolUses.map(async (t) => {
          emit("tool_status", { tool: t.name, status: "running" });
          const t0 = Date.now();
          const { result } = await executeTool(t.name, t.input, toolCtx);
          await audit({
            sessionId: session.sessionId,
            userId: user.userId,
            turnIndex: session.turnIndex,
            actor: "llm",
            eventType: "tool_call",
            toolName: t.name,
            toolInput: t.input,
            toolOutput: result,
            latencyMs: Date.now() - t0,
          });
          emit("tool_status", { tool: t.name, status: "done" });
          return { type: "tool_result" as const, tool_use_id: t.id, content: JSON.stringify(result), ...(result.ok ? {} : { is_error: true }) };
        }),
      );
      // ── 4. Claude observes all results (one user message) on the next iteration ──
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    const code =
      e instanceof LLMRefusalError ? "AGENT_DECLINED"
      : e instanceof LLMConfigError ? `AGENT_MISCONFIGURED_${e.reason.toUpperCase()}`
      : e instanceof LLMUnavailableError ? `AGENT_UNAVAILABLE_${e.reason.toUpperCase()}`
      : deadline.aborted ? "AGENT_TIMEOUT" : "AGENT_ERROR";
    // Customers always get the polite message; in local dev, say what an operator must fix.
    const devHint =
      config.devMode && e instanceof LLMConfigError
        ? { invalid_api_key: "【開発者向け / Dev】ANTHROPIC_API_KEY が無効です — backend/.env のキーを確認して backend を再起動してください。",
            permission_denied: "【開発者向け / Dev】この API キーではモデルを利用できません。",
            model_not_found: `【開発者向け / Dev】モデル ${config.llm.mainModel} が見つかりません (LLM_MAIN_MODEL)。` }[e.reason]
        : null;
    if (e instanceof LLMConfigError) console.error(`[agent] Claude API configuration error: ${e.reason}`);
    emit("error", { code, message: devHint ? `${UNAVAILABLE[session.locale]}\n${devHint}` : UNAVAILABLE[session.locale] });
    await audit({ sessionId: session.sessionId, userId: user.userId, turnIndex: session.turnIndex, actor: "system", eventType: "error", toolOutput: { code, error: String(e) } });
    // Keep the history valid: an unanswered tool_use or a dangling turn would break the next request.
    repairHistory(messages);
  } finally {
    session.sessionExtraAllergens = [...ctxAllergens];
    const cartNow = await getCart(user.userId).catch(() => null);
    session.cartVersionSeen = cartNow?.lines.length ? cartNow.version : null; // same rule as contextBlocksForTurn
    await saveSession(session);
    emit("message_end", { turn: session.turnIndex });
  }
}

/** After a failure mid-turn, make sure every tool_use has a tool_result so the next turn is a valid request. */
function repairHistory(messages: Message[]) {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || typeof last.content === "string") return;
  const pending = (last.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use");
  if (pending.length) {
    messages.push({
      role: "user",
      content: pending.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id!, is_error: true, content: "Interrupted: the service was temporarily unavailable. Call get_cart to check the current state before continuing." })),
    });
  }
}
