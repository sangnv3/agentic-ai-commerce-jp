import { redis } from "../checkout/confirmation.js";
import { config } from "../config.js";
import type { TurnUsage } from "./provider.js";

/**
 * Per-user LLM spend guard (JST calendar day). Checked before each turn, charged after each model call.
 * When exceeded, the agent stops calling Claude for that user today; the cart stays saved.
 */
function dayKey(userId: string): string {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  return `llm:budget:${userId}:${day}`;
}

export async function hasBudget(userId: string): Promise<boolean> {
  const [v, global] = await Promise.all([redis.hmget(dayKey(userId), "usd", "turns"), redis.hget(dayKey("__global__"), "usd")]);
  const usd = Number(v[0] ?? 0);
  const turns = Number(v[1] ?? 0);
  return usd < config.llm.perUserDailyUsd && turns < config.llm.perUserDailyTurns && Number(global ?? 0) < config.llm.globalDailyUsd;
}

export async function charge(userId: string, usage: TurnUsage, countTurn = false): Promise<void> {
  const key = dayKey(userId);
  const globalKey = dayKey("__global__");
  await redis
    .multi()
    .hincrbyfloat(globalKey, "usd", usage.costUsd)
    .expire(globalKey, 2 * 86400)
    .hincrbyfloat(key, "usd", usage.costUsd)
    .hincrby(key, "tokens", usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
    .hincrby(key, "turns", countTurn ? 1 : 0)
    .expire(key, 2 * 86400)
    .exec();
}
