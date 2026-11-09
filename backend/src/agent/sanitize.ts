/**
 * Prompt-injection hardening for data that comes from restaurants / users / third parties
 * (menu descriptions, restaurant names, reviews) before it is placed in a tool_result.
 *
 * This is one layer only. The real protection is structural: the LLM has no payment tool,
 * hard constraints are enforced server-side, and every tool input is validated.
 */

// Zero-width, bidi-control and other invisible characters often used to hide instructions.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­]/g;
// ASCII control characters except \n and \t.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Our own delimiter must never appear inside data.
const DELIMITER = /<\/?\s*untrusted_data\s*>/gi;
// Heuristic markers; matches are neutralized (not removed) and counted for monitoring.
const SUSPICIOUS =
  /(ignore (all|previous|the above)|disregard|system prompt|you are now|新しい指示|以前の指示を無視|指示を無視|<\s*\/?\s*(system|assistant|tool)[^>]*>)/gi;

export interface SanitizeResult {
  text: string;
  flagged: boolean;
}

export function sanitizeUntrusted(input: string | null | undefined, maxLen = 400): SanitizeResult {
  if (!input) return { text: "", flagged: false };
  let text = input.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, "").replace(DELIMITER, "");
  let flagged = false;
  text = text.replace(SUSPICIOUS, (m) => {
    flagged = true;
    return `[${m.length}文字省略]`;
  });
  // Strip URLs and phone/email-like strings: the agent never needs them from menu data.
  text = text
    .replace(/https?:\/\/\S+/gi, "[URL省略]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[メール省略]");
  if (text.length > maxLen) text = text.slice(0, maxLen) + "…";
  return { text, flagged };
}

/** Wrap untrusted text so the model (per system prompt) treats it as data only. */
export function wrapUntrusted(input: string | null | undefined, maxLen?: number): string {
  return `<untrusted_data>${sanitizeUntrusted(input, maxLen).text}</untrusted_data>`;
}

/** Remove platform-reserved markup from customer chat input. */
export function sanitizeUserChat(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(CONTROL, "")
    .replace(/<\/?\s*(turn_context|untrusted_data|platform_event)[^>]*>/gi, "")
    .slice(0, 2000);
}
