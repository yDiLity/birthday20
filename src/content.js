import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  path.join(process.cwd(), "content", "questions.json"),
  fileURLToPath(new URL("../content/questions.json", import.meta.url)),
];

function loadContent() {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, "utf8"));
      }
    } catch (error) {
      throw new Error(`Не удалось прочитать контент (${candidate}): ${error.message}`);
    }
  }
  throw new Error(`Контент не найден. Проверенные пути: ${CANDIDATES.join(", ")}`);
}

const BASE = loadContent();
const clone = (value) => JSON.parse(JSON.stringify(value));

export const OPTION_KEYS = ["А", "Б", "В"];

const ALIASES = new Map([
  ["а", 0], ["a", 0], ["1", 0], ["1.", 0], ["one", 0], ["первый", 0],
  ["б", 1], ["b", 1], ["2", 1], ["2.", 1], ["two", 1], ["второй", 1],
  ["в", 2], ["v", 2], ["c", 2], ["3", 2], ["3.", 2], ["three", 2], ["третий", 2],
]);

export function optionIndexFromKey(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (ALIASES.has(raw)) return ALIASES.get(raw);
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n - 1;
  return null;
}

export function optionKey(index) {
  return OPTION_KEYS[index] ?? String(index + 1);
}

/* ------------------------- слой правок поверх JSON ------------------------- */

export let overrides = {};
export let content = clone(BASE);
export let questions = [];
export let totalQuestions = 0;

/**
 * Ключи правок:
 *   q:<q_id>:text            — текст вопроса
 *   q:<q_id>:label:<А/Б/В>   — вариант ответа
 *   q:<q_id>:reaction:<А/Б/В>— реакция
 *   q:<q_id>:video:<А/Б/В>   — file_id видео
 *   final:video | final:text — финальное видео / текст
 *   greeting:text | no_video:text
 */
export function parseKey(key) {
  const [kind, first, second, third] = String(key).split(":");
  if (kind !== "q") return { kind, field: first, id: null, option: null };
  if (!second) return null;
  if (second === "text") return { kind, id: first, field: "text", option: null };
  return { kind, id: first, field: second, option: third };
}

function rebuild() {
  const result = clone(BASE);

  const byId = new Map();
  for (const category of result.categories ?? []) {
    for (const question of category.questions ?? []) byId.set(question.id, question);
  }

  for (const [key, value] of Object.entries(overrides)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const { kind, id, field, option } = parsed;
    const text = value === null || value === undefined ? "" : String(value);

    if (kind === "q") {
      const question = byId.get(id);
      if (!question) continue;
      if (field === "text") {
        question.text = text;
        continue;
      }
      const index = optionIndexFromKey(option);
      if (index === null || !question.options?.[index]) continue;
      if (field === "label") question.options[index].label = text;
      else if (field === "reaction") question.options[index].reaction_text = text;
      else if (field === "video") question.options[index].video_file_id = text || null;
      else if (field === "delete") question.options.splice(index, 1);
      continue;
    }

    if (kind === "final") {
      if (field === "video") result.final_video_file_id = text || null;
      if (field === "text") result.final_text = text;
      continue;
    }

    if (kind === "greeting" && field === "text") result.greeting = text;
    if (kind === "no_video" && field === "text") result.no_video_text = text;
  }

  result.categories = (result.categories ?? []).filter((category) => (category.questions ?? []).length > 0);
  content = result;
  questions = result.categories.flatMap((category) =>
    (category.questions ?? []).map((question) => ({
      ...question,
      categoryId: category.id,
      categoryTitle: category.title,
    })),
  );
  totalQuestions = questions.length;
}

rebuild();

export function getOverrides() {
  return { ...overrides };
}

export function applyOverrides(next) {
  overrides = next && typeof next === "object" ? { ...next } : {};
  rebuild();
  return overrides;
}

export function setOverride(key, value) {
  return applyOverrides({ ...overrides, [key]: value });
}

export function clearOverride(key) {
  const next = { ...overrides };
  delete next[key];
  return applyOverrides(next);
}

export function clearAllOverrides() {
  return applyOverrides({});
}

export function makeKey(kind, id, field, option) {
  return [kind, id, field, option].filter((part) => part !== undefined && part !== null && part !== "").join(":");
}

export function hasOverrides() {
  return Object.keys(overrides).length > 0;
}

/* --------------------------------- helpers -------------------------------- */

export function getQuestion(index) {
  return questions[index] ?? null;
}

export function findQuestionById(id) {
  return questions.find((question) => question.id === String(id).trim().toLowerCase()) ?? null;
}

export function fill(template, { name, count } = {}) {
  return String(template ?? "")
    .replaceAll("{name}", name || "Именинник")
    .replaceAll("{count}", String(count ?? totalQuestions));
}

export function questionBlock(index) {
  const question = getQuestion(index);
  if (!question) return "";
  return [
    `${index + 1}/${totalQuestions} · ${question.categoryTitle}`,
    question.text,
    ...question.options.map((option, i) => `${optionKey(i)}. ${option.label} → ${option.reaction_text}`),
  ].join("\n");
}

export function contentStats() {
  return { categories: content.categories.length, questions: questions.length, videosNeeded: questions.length * OPTION_KEYS.length + 1 };
}

/** Видео варианта с учётом правок: JSON + override. */
export function videoFor(question, optionIndex) {
  const option = question?.options?.[optionIndex];
  const value = option?.video_file_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function finalVideo() {
  const value = content.final_video_file_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
