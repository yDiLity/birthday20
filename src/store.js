import { config } from "./config.js";

const memory = new Map();
const memorySets = new Map();

let warnedRedis = false;
let warnedMemory = false;
let redisPromise;

function warn(message, error) {
  const detail = error?.stack || error?.message || error || "";
  console.warn(`[store] ${message}${detail ? ` — ${detail}` : ""}`);
  warnedMemory = true;
}

async function client() {
  if (!config.redisUrl || !config.redisToken) {
    if (!warnedMemory) {
      warnedMemory = true;
      console.warn("[store] Redis не сконфигурирован, работаю в памяти процесса (сессия переживёт только тёплый старт)");
    }
    return null;
  }
  if (!redisPromise) {
    redisPromise = import("@upstash/redis")
      .then(({ Redis }) => new Redis({ url: config.redisUrl, token: config.redisToken }))
      .catch((error) => {
        warn("не удалось подключиться к Redis, fallback в память", error);
        redisPromise = null;
        return null;
      });
  }
  return redisPromise;
}

const full = (key) => `${config.redisPrefix}:${key}`;

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

export async function getValue(key) {
  const k = full(key);
  const redis = await client();
  if (redis) {
    try {
      const value = await redis.get(k);
      if (value !== null && value !== undefined) return value;
    } catch (error) {
      warn("GET не удался, беру из памяти", error);
    }
  }
  return memoryGet(k);
}

export async function setValue(key, value, ttlSeconds = config.sessionTtlSeconds) {
  const k = full(key);
  memory.set(k, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  const redis = await client();
  if (redis) {
    try {
      await redis.set(k, value, { ex: ttlSeconds });
    } catch (error) {
      warn("SET не удался, значение только в памяти", error);
    }
  }
  return value;
}

export async function deleteValue(key) {
  const k = full(key);
  memory.delete(k);
  const redis = await client();
  if (redis) {
    try {
      await redis.del(k);
    } catch (error) {
      warn("DEL не удался, удаляю из памяти", error);
    }
  }
}

export async function addToSet(key, member) {
  const k = full(key);
  if (!memorySets.has(k)) memorySets.set(k, new Set());
  memorySets.get(k).add(String(member));
  const redis = await client();
  if (redis) {
    try {
      await redis.sadd(k, String(member));
    } catch (error) {
      warn("SADD не удался", error);
    }
  }
}

export async function listSet(key) {
  const k = full(key);
  const redis = await client();
  if (redis) {
    try {
      const members = await redis.smembers(k);
      if (Array.isArray(members) && members.length) return members.map(String);
    } catch (error) {
      warn("SMEMBERS не удался", error);
    }
  }
  return [...(memorySets.get(k) ?? [])];
}

export async function removeFromSet(key, member) {
  const k = full(key);
  memorySets.get(k)?.delete(String(member));
  const redis = await client();
  if (redis) {
    try {
      await redis.srem(k, String(member));
    } catch (error) {
      warn("SREM не удался", error);
    }
  }
}

const sessionKey = (chatId, userId) => `session:${chatId}:${userId}`;
const chatUsersKey = (chatId) => `chat:${chatId}:users`;
const overridesKey = "content:overrides";
const pendingKey = (adminId, chatId) => `admin:pending:${adminId}:${chatId}`;

export function getSession(chatId, userId) {
  return getValue(sessionKey(chatId, userId));
}

export async function saveSession(session) {
  session.updatedAt = Date.now();
  await setValue(sessionKey(session.chatId, session.userId), session);
  await addToSet(chatUsersKey(session.chatId), session.userId);
  return session;
}

export function resetSession(chatId, userId) {
  return deleteValue(sessionKey(chatId, userId));
}

export function listChatUserIds(chatId) {
  return listSet(chatUsersKey(chatId));
}

export async function getOverrides() {
  const value = await getValue(overridesKey);
  return value && typeof value === "object" ? value : {};
}

export function saveOverrides(overrides) {
  return setValue(overridesKey, overrides, 60 * 60 * 24 * 365);
}

export function getPending(adminId, chatId) {
  return getValue(pendingKey(adminId, chatId));
}

export function savePending(adminId, chatId, state) {
  return setValue(pendingKey(adminId, chatId), state, 60 * 60 * 2);
}

export function clearPending(adminId, chatId) {
  return deleteValue(pendingKey(adminId, chatId));
}

/* ---------------------- персональные тесты и мастер ----------------------- */

const quizKey = (code) => `quiz:${code}`;
const ownerQuizzesKey = (ownerId) => `quizzes:${ownerId}`;
const personalSessionKey = (chatId) => `personal:${chatId}`;
const draftKey = (userId, chatId) => `draft:${userId}:${chatId}`;
const YEAR = 60 * 60 * 24 * 365;

export function getQuiz(code) {
  return getValue(quizKey(String(code ?? "")));
}

export async function saveQuiz(quiz) {
  await setValue(quizKey(quiz.code), quiz, YEAR);
  await addToSet(ownerQuizzesKey(quiz.ownerId), quiz.code);
  return quiz;
}

export async function deleteQuiz(code) {
  const quiz = await getQuiz(code);
  if (quiz?.ownerId !== undefined && quiz?.ownerId !== null) {
    await removeFromSet(ownerQuizzesKey(quiz.ownerId), String(code));
  }
  return deleteValue(quizKey(String(code ?? "")));
}

export function listOwnerQuizCodes(ownerId) {
  return listSet(ownerQuizzesKey(ownerId));
}

export function getPersonalSession(chatId) {
  return getValue(personalSessionKey(chatId));
}

export function savePersonalSession(chatId, session) {
  return setValue(personalSessionKey(chatId), session, config.sessionTtlSeconds);
}

export function clearPersonalSession(chatId) {
  return deleteValue(personalSessionKey(chatId));
}

export function getDraft(userId, chatId) {
  return getValue(draftKey(userId, chatId));
}

export function saveDraft(userId, chatId, draft) {
  return setValue(draftKey(userId, chatId), draft, 60 * 60 * 6);
}

export function clearDraft(userId, chatId) {
  return deleteValue(draftKey(userId, chatId));
}

export async function pingRedis() {
  const redis = await client();
  if (!redis) return false;
  try {
    await redis.ping();
    return true;
  } catch (error) {
    warn("PING не удался", error);
    return false;
  }
}

export const storeWarnings = () => ({ warnedRedis, warnedMemory });
