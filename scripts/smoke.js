import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  content,
  questions,
  totalQuestions,
  getQuestion,
  findQuestionById,
  optionIndexFromKey,
  questionBlock,
  fill,
  contentStats,
  videoFor,
  finalVideo,
  applyOverrides,
  getOverrides,
  setOverride,
  clearAllOverrides,
  makeKey,
} from "../src/content.js";
import {
  saveSession,
  getSession,
  resetSession,
  listChatUserIds,
  getOverrides as loadOverrides,
  saveOverrides,
  savePending,
  getPending,
  clearPending,
  saveQuiz,
  getQuiz,
  deleteQuiz,
  listOwnerQuizCodes,
  savePersonalSession,
  getPersonalSession,
  clearPersonalSession,
  saveDraft,
  getDraft,
  clearDraft,
} from "../src/store.js";
import {
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  CODE_RE,
  TEMPLATES,
  normalizeQuiz,
  generateCode,
  quizQuestionText,
  quizSummary,
  quizFromTemplate,
  emptyQuiz,
} from "../src/quizzes.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

console.log("\n== Контент ==");
check("5 категорий", () => assert.equal(content.categories.length, 5));
check(`${totalQuestions} вопросов`, () => assert.ok(totalQuestions >= 10 && totalQuestions <= 12, `получено ${totalQuestions}`));
check("по 3 варианта на вопрос", () => {
  for (const q of questions) assert.equal(q.options.length, 3, `${q.id}: ${q.options.length}`);
});
check("уникальные id", () => {
  const ids = questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
});
check("вопросы и реакции не пустые", () => {
  for (const q of questions) {
    assert.ok(q.text?.trim(), `${q.id}: пустой text`);
    for (const o of q.options) {
      assert.ok(o.label?.trim(), `${q.id}: пустой label`);
      assert.ok(o.reaction_text?.trim(), `${q.id}: пустая reaction_text`);
    }
  }
});
check("getQuestion/findQuestionById", () => {
  assert.equal(getQuestion(0).id, questions[0].id);
  assert.equal(findQuestionById(questions[3].id).id, questions[3].id);
  assert.equal(findQuestionById("нет-такого"), null);
});
check("optionIndexFromKey (А/1/б/B/В/3)", () => {
  assert.equal(optionIndexFromKey("А"), 0);
  assert.equal(optionIndexFromKey("1"), 0);
  assert.equal(optionIndexFromKey("б"), 1);
  assert.equal(optionIndexFromKey("B"), 1);
  assert.equal(optionIndexFromKey("В"), 2);
  assert.equal(optionIndexFromKey("3"), 2);
  assert.equal(optionIndexFromKey("4"), null);
});
check("fill подставляет {name} и {count}", () => {
  assert.equal(fill("{name} / {count}", { name: "Игорь", count: totalQuestions }), `Игорь / ${totalQuestions}`);
});
check("вопросы пронумерованы 1..N", () => {
  for (let i = 0; i < totalQuestions; i += 1) assert.equal(getQuestion(i).id, questions[i].id);
});

console.log("\n== Правки контента (слой поверх JSON) ==");
check("правка текста вопроса применяется", () => {
  const base = findQuestionById("q1").text;
  setOverride(makeKey("q", "q1", "text"), "Новый текст вопроса");
  assert.equal(findQuestionById("q1").text, "Новый текст вопроса");
  assert.notEqual(base, "Новый текст вопроса");
});
check("правка варианта ответа применяется", () => {
  setOverride(makeKey("q", "q1", "label", "Б"), "Новый вариант Б");
  assert.equal(findQuestionById("q1").options[1].label, "Новый вариант Б");
});
check("правка реакции применяется", () => {
  setOverride(makeKey("q", "q1", "reaction", "В"), "Новая реакция");
  assert.equal(findQuestionById("q1").options[2].reaction_text, "Новая реакция");
});
check("остальные варианты не тронуты", () => {
  assert.notEqual(findQuestionById("q1").options[0].label, "Новый вариант Б");
});
check("видео-правка применяется", () => {
  assert.equal(videoFor(findQuestionById("q1"), 0), null);
  setOverride(makeKey("q", "q1", "video", "А"), "BAACAgIAAxTEST");
  assert.equal(videoFor(findQuestionById("q1"), 0), "BAACAgIAAxTEST");
  setOverride(makeKey("final", null, "video"), "BAACAgIAAxFINAL");
  assert.equal(finalVideo(), "BAACAgIAAxFINAL");
});
check("правка приветствия и финала применяется", () => {
  setOverride(makeKey("greeting", null, "text"), "Привет, {name}! {count}");
  setOverride(makeKey("final", null, "text"), "Финал, {name}!");
  assert.equal(fill(content.greeting, { name: "Игорь", count: 12 }), "Привет, Игорь! 12");
  assert.equal(fill(content.final_text, { name: "Игорь", count: 12 }), "Финал, Игорь!");
});
check("правка на неизвестный вопрос игнорируется", () => {
  setOverride(makeKey("q", "q999", "text"), "несуществующий");
  assert.equal(findQuestionById("q999"), null);
});
check("applyOverrides/getOverrides", () => {
  assert.ok(Object.keys(getOverrides()).length >= 4);
  applyOverrides({});
  assert.equal(Object.keys(getOverrides()).length, 0);
  assert.equal(findQuestionById("q1").text, questions[0].text);
});
check("в JSON всё восстановилось", () => {
  assert.equal(videoFor(findQuestionById("q1"), 0), null);
  assert.equal(finalVideo(), null);
  assert.equal(content.greeting.includes("{name}"), true);
});

console.log("\n== Персональные тесты ==");
const sampleQuiz = () => ({
  ...emptyQuiz({ id: 7, first_name: "Орг" }),
  title: "Тест",
  questions: Array.from({ length: MIN_QUESTIONS }, (_, i) => ({
    id: `t${i + 1}`,
    text: `Вопрос ${i + 1}?`,
    options: [{ label: "Да", reaction_text: "", video_file_id: null }, { label: "Нет", reaction_text: "", video_file_id: null }, { label: "Может быть", reaction_text: "", video_file_id: null }],
  })),
});

check("нормализация: подставляет реакции по умолчанию", () => {
  const { quiz, ok, errors } = normalizeQuiz(sampleQuiz());
  assert.equal(ok, true, errors.join("; "));
  assert.equal(quiz.questions[0].options[0].reaction_text, "Ответ: Да");
});

check("нормализация: отсекает пустые вопросы и варианты", () => {
  const raw = sampleQuiz();
  raw.questions[1].text = "   ";
  raw.questions[2].options = [{ label: "  " }];
  const { quiz, errors } = normalizeQuiz(raw);
  assert.equal(quiz.questions.length, MIN_QUESTIONS - 2);
  assert.ok(errors.some((error) => /пустой текст/.test(error)), errors.join("; "));
  assert.ok(errors.some((error) => /минимум 2 варианта/.test(error)), errors.join("; "));
});

check("нормализация: минимум вопросов", () => {
  const raw = sampleQuiz();
  raw.questions = raw.questions.slice(0, 2);
  const { ok, errors } = normalizeQuiz(raw);
  assert.equal(ok, false);
  assert.match(errors.join(" "), /минимум/i);
});

check("нормализация: лимит вопросов", () => {
  const raw = sampleQuiz();
  raw.questions = Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => raw.questions[0]);
  const { ok } = normalizeQuiz(raw);
  assert.equal(ok, false);
});

check("код из 6 цифр и не начинается с нуля", () => {
  const code = generateCode([]);
  assert.match(code, /^[1-9]\d{5}$/, code);
  assert.equal(CODE_RE.test(code), true);
});

check("код не повторяется", () => {
  const codes = Array.from({ length: 50 }, () => generateCode([]));
  assert.equal(new Set(codes).size, 50, "коды повторяются");
  const busy = ["123456", "234567"];
  assert.ok(!busy.includes(generateCode(busy)), "выдан занятый код");
  assert.equal(CODE_RE.test("1234"), true);
  assert.equal(CODE_RE.test("123"), false);
  assert.equal(CODE_RE.test("привет"), false);
});

check("в шаблоне есть вопросы и варианты", () => {
  for (const key of Object.keys(TEMPLATES)) {
    const quiz = quizFromTemplate(key, content);
    assert.ok(quiz.questions.length >= MIN_QUESTIONS, `${key}: ${quiz.questions.length}`);
    for (const question of quiz.questions) {
      assert.ok(question.options.length >= 2, `${key}/${question.id}: ${question.options.length}`);
      assert.ok(question.text.length > 3, `${key}/${question.id}: пустой текст`);
    }
  }
});

check("шаблон «из основной игры» копирует 12 вопросов", () => {
  const quiz = quizFromTemplate("main", content);
  assert.equal(quiz.questions.length, totalQuestions);
  assert.equal(quiz.questions[0].text, getQuestion(0).text);
});

check("текст вопроса теста собирается верно", () => {
  const { quiz } = normalizeQuiz(sampleQuiz());
  const text = quizQuestionText(quiz, 1);
  assert.match(text, /вопрос 2 из 3/);
  assert.match(text, /А\. Да/);
  assert.match(text, /В\. Может быть/);
});

check("итоги теста показывают ответы и пропуски", () => {
  const { quiz } = normalizeQuiz(sampleQuiz());
  const summary = quizSummary({
    ...quiz,
    answers: [{ questionIndex: 0, optionKey: "Б", label: "Нет" }, { questionIndex: 2, optionKey: "А", label: "Да" }],
  });
  assert.match(summary, /1\. Б\. Нет/);
  assert.match(summary, /2\. — без ответа/);
  assert.match(summary, /3\. А\. Да/);
});

console.log("\n== Хранилище (fallback в память, если нет Redis) ==");
await (async () => {
  try {
    const quiz = { ...sampleQuiz(), code: "424242", ownerId: 7, ownerName: "Орг", title: "Тест про Орга" };
    await saveQuiz(quiz);
    const loaded = await getQuiz("424242");
    assert.equal(loaded.title, "Тест про Орга");
    assert.equal(loaded.questions.length, MIN_QUESTIONS);
    assert.ok((await listOwnerQuizCodes(7)).includes("424242"));
    await deleteQuiz("424242");
    assert.equal(await getQuiz("424242"), null);
    assert.ok(!(await listOwnerQuizCodes(7)).includes("424242"));
    console.log("  ok   тесты: save/get/list/delete");
  } catch (error) {
    failures += 1;
    console.error(`  FAIL тесты: ${error.message}`);
  }

  try {
    await savePersonalSession(-1002, { chatId: -1002, code: "424242", questionIndex: 0, answers: [] });
    assert.equal((await getPersonalSession(-1002)).code, "424242");
    await clearPersonalSession(-1002);
    assert.equal(await getPersonalSession(-1002), null);
    console.log("  ok   сессия теста в чате: save/get/clear");
  } catch (error) {
    failures += 1;
    console.error(`  FAIL сессия теста: ${error.message}`);
  }

  try {
    await saveDraft(7, 7, { step: "title", quiz: sampleQuiz() });
    assert.equal((await getDraft(7, 7)).step, "title");
    await clearDraft(7, 7);
    assert.equal(await getDraft(7, 7), null);
    console.log("  ok   черновик теста: save/get/clear");
  } catch (error) {
    failures += 1;
    console.error(`  FAIL черновик: ${error.message}`);
  }
  try {
    await saveSession({ chatId: -1001, userId: 42, userName: "Тест", questionIndex: 0, answers: [], finished: false });
    const session = await getSession(-1001, 42);
    assert.equal(session.userId, 42);
    assert.ok(session.updatedAt > 0);
    const users = await listChatUserIds(-1001);
    assert.ok(users.map(String).includes("42"), `users=${users}`);
    await resetSession(-1001, 42);
    assert.equal(await getSession(-1001, 42), null);
    console.log("  ok   сессия save/get/list/reset");
  } catch (error) {
    failures += 1;
    console.error(`  FAIL сессия: ${error.message}`);
  }

  try {
    await saveOverrides({ [makeKey("q", "q1", "text")]: "Из Redis" });
    const loaded = await loadOverrides();
    assert.equal(loaded[makeKey("q", "q1", "text")], "Из Redis");
    applyOverrides(loaded);
    assert.equal(findQuestionById("q1").text, "Из Redis");
    console.log("  ok   правки контента сохранены и прочитаны");
  } catch (error) {
    failures += 1;
    console.error(`  FAIL правки: ${error.message}`);
  }

  try {
    await savePending(1, -1001, { kind: "question", questionId: "q1", field: "text" });
    const pending = await getPending(1, -1001);
    assert.equal(pending.questionId, "q1");
    await clearPending(1, -1001);
    assert.equal(await getPending(1, -1001), null);
    console.log("  ok   пошаговое редактирование: pending save/get/clear");
  } catch (error) {
    failures += 1;
    console.error(`  FAIL pending: ${error.message}`);
  }

  applyOverrides({});
  await saveOverrides({});
})();

console.log("\n== Конфигурация ==");
check("конфиг читается", () => {
  assert.ok(typeof config.sessionTtlSeconds === "number" && config.sessionTtlSeconds > 0);
  assert.equal(config.redisPrefix, config.redisPrefix.trim());
});
console.log("  info BOT_TOKEN:", config.botToken ? "задан" : "НЕ ЗАДАН");
console.log("  info ADMIN_ID:", config.adminIds.length ? config.adminIds.join(",") : "НЕ ЗАДАН");
console.log("  info Redis:", config.redisUrl ? "сконфигурирован" : "НЕ СКОНФИГУРИРОВАН (fallback в память)");

console.log("\n== Сценарий для проверки ==");
const stats = contentStats();
console.log(`  категорий: ${stats.categories}, вопросов: ${stats.questions}, видео нужно: ${stats.videosNeeded}`);
if (process.argv.includes("--preview")) {
  console.log(`\n${fill(content.greeting, { name: config.heroName, count: totalQuestions })}\n`);
  for (let i = 0; i < totalQuestions; i += 1) console.log(`${questionBlock(i)}\n`);
  console.log(fill(content.final_text, { name: config.heroName, count: totalQuestions }));
}

console.log(failures ? `\n❌ Провалено проверок: ${failures}\n` : "\n✅ Все проверки прошли\n");
process.exit(failures ? 1 : 0);
