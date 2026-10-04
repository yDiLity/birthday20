import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Подхватываем .env.local для локальных скриптов (npm run webhook, npm run bot:info, тесты).
 * На Vercel переменные приходят из окружения, .env.local там нет — ничего не ломается.
 * Реальные переменные окружения имеют приоритет и не перезаписываются.
 */
function loadLocalEnv() {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const raw = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env.local нет или недоступен — используем process.env */
  }
}

loadLocalEnv();

function num(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function list(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  botToken: String(process.env.BOT_TOKEN ?? "").trim(),
  adminIds: [...new Set([...list(process.env.ADMIN_ID), ...list(process.env.ADMIN_IDS)].map(num).filter(Boolean))],
  heroId: num(process.env.HERO_ID),
  heroName: String(process.env.HERO_NAME ?? "").trim() || "Именинник",
  allowRestart: String(process.env.ALLOW_RESTART ?? "true").toLowerCase() !== "false",
  sessionTtlSeconds: Math.max(60, (num(process.env.SESSION_TTL_DAYS) ?? 7) * 24 * 60 * 60),
  redisUrl: String(process.env.UPSTASH_REDIS_REST_URL ?? "").trim(),
  redisToken: String(process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim(),
  redisPrefix: String(process.env.REDIS_PREFIX ?? "bdq").trim() || "bdq",
};

export function isAdmin(userId) {
  return config.adminIds.includes(Number(userId));
}

export function isHero(userId) {
  return config.heroId === null || Number(userId) === config.heroId;
}

export function validate() {
  const problems = [];
  if (!config.botToken) problems.push("BOT_TOKEN не задан");
  if (!config.adminIds.length) problems.push("ADMIN_ID (или ADMIN_IDS) не задан — админка будет недоступна");
  if (!config.redisUrl || !config.redisToken) problems.push("UPSTASH_REDIS_REST_URL / _TOKEN не заданы — будет fallback в память (сессия пропадёт при холодном старте)");
  return problems;
}
