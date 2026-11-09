import type { UserContext } from "../auth/entra.js";
import { getAgentContext } from "../commerce/customers.js";
import { FX_JPY_PER_UNIT } from "../commerce/settings.js";
import { config } from "../config.js";
import { charge } from "../llm/budget.js";
import { summarizeConversation } from "./lightTasks.js";
import type { AgentSession } from "./sessionStore.js";

/**
 * Context management.
 * 1) Customer context: a compact profile + preference summary is put in the user turn when the session starts
 *    and again only when the preference profile version changes — so Claude rarely needs get_user_profile /
 *    get_preferences round trips, and the cached prefix stays stable.
 * 2) Long conversations: above a token threshold, Haiku summarizes the history and a new epoch starts
 *    from that summary (append-only within each epoch).
 */
type CustomerContext = Awaited<ReturnType<typeof getAgentContext>>;

export async function loadCustomerContext(user: UserContext): Promise<CustomerContext> {
  // Compact view (names of liked items, top weights only, no PII beyond the family name; no card data —
  // only labels like "VISA **** 4242").
  return getAgentContext(user.userId);
}

export function renderCustomerContext(c: CustomerContext): string {
  return `<customer_context>${JSON.stringify(c)}</customer_context>`;
}

/** Returns the text block(s) to prepend to this turn's user message. */
export async function contextBlocksForTurn(session: AgentSession, user: UserContext): Promise<string[]> {
  const jst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const fx = Object.entries(FX_JPY_PER_UNIT).map(([cur, rate]) => `1 ${cur} ≈ ${rate} JPY`).join(", ");
  const blocks = [`<turn_context now_jst="${jst}" locale="${session.locale}" fx="${fx}" />`];

  if (session.messages.length === 0 && session.carriedSummary) {
    blocks.push(`<conversation_summary>${session.carriedSummary}</conversation_summary>`);
  }
  const ctx = await loadCustomerContext(user);
  if (session.messages.length === 0 || ctx.preferences.version !== session.preferenceVersionSent) {
    blocks.push(renderCustomerContext(ctx));
    session.preferenceVersionSent = ctx.preferences.version;
  }
  return blocks;
}

/** Start a new epoch from a summary when the prompt has grown too large. */
export async function maybeSummarize(session: AgentSession): Promise<boolean> {
  if (session.lastInputTokens < config.llm.summarizeAboveInputTokens || session.messages.length < 6) return false;
  const { output, usage } = await summarizeConversation(session.messages);
  await charge(session.userId, usage);
  session.carriedSummary = JSON.stringify(output);
  session.sessionExtraAllergens = [...new Set([...session.sessionExtraAllergens, ...output.session_allergens])];
  session.messages = []; // fresh prefix: no earlier thinking blocks are replayed
  session.epoch += 1;
  session.preferenceVersionSent = null; // re-send customer context in the new epoch
  session.lastInputTokens = 0;
  return true;
}
