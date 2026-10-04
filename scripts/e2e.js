import { createRequire } from "node:module";
import assert from "node:assert/strict";

process.env.BOT_TOKEN = process.env.BOT_TOKEN || "TEST-TOKEN";
process.env.ADMIN_ID = "1";
process.env.HERO_ID = "2";
process.env.HERO_NAME = "Игорь";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { totalQuestions, getQuestion, findQuestionById, getOverrides, finalVideo } = await import("../src/content.js");
const { listOwnerQuizCodes, saveQuiz } = await import("../src/store.js");
/* Переопределения пересобирают контент, поэтому читаем его через функцию, а не через импорт. */
const currentGreeting = async () => (await import("../src/content.js")).content.greeting;
const { handleUpdate, setTelegramClient } = await import("../src/bot.js");
const { getSession } = await import("../src/store.js");

const HERO = 2;
const CHAT = -1001234567890;
const ADMIN = 1;
const calls = [];

function record(method, payload = {}) {
  if (method === "getMe") return { id: 1, is_bot: true, first_name: "TestBot", username: "test_bot" };

  if (method === "sendMessage") {
    const buttons = payload.reply_markup?.inline_keyboard?.flat().map((b) => b.text).join(" | ");
    calls.push(`MSG ${JSON.stringify({ chat_id: payload.chat_id, text: String(payload.text ?? ""), buttons })}`);
  } else if (method === "sendVideo") {
    calls.push(`VIDEO ${JSON.stringify({ chat_id: payload.chat_id, video: payload.video, next: Boolean(payload.reply_markup) })}`);
  } else if (method === "answerCallbackQuery") {
    calls.push(`CB ${JSON.stringify({ text: payload.text ?? "" })}`);
  } else {
    calls.push(`${method} ${JSON.stringify(payload)}`);
  }
  return { message_id: calls.length, video: { file_id: payload.video || "stub" } };
}

function normalize(args) {
  const payload = {};
  for (const arg of args) {
    if (Buffer.isBuffer(arg)) continue;
    if (arg && typeof arg === "object" && !Array.isArray(arg)) Object.assign(payload, arg);
  }
  const numbers = args.filter((arg) => typeof arg === "number");
  const strings = args.filter((arg) => typeof arg === "string");
  if (numbers.length) payload.chat_id = numbers[0];
  if (strings.length) payload.text = strings[strings.length - 1];
  return payload;
}

/* Подменяем сетевой слой telegraf: ни одного реального запроса в Telegram. */
const require = createRequire(`${process.cwd()}/noop.js`);
const nodeFetch = require("node-fetch");
nodeFetch.default = async (url, init) => {
  const method = String(url.pathname ?? url).split("/").pop();
  const payload = init?.body ? JSON.parse(init.body) : {};
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, result: record(method, payload) }) };
};

const fakeTelegram = new Proxy(
  {
    token: process.env.BOT_TOKEN,
    options: { apiRoot: "https://api.telegram.org" },
    callApi: async (method, data) => ({ ok: true, result: record(method, data ?? {}) }),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      return async (...args) => ({ ok: true, result: record(prop, normalize(args)) });
    },
  },
);

setTelegramClient(fakeTelegram);

let updateId = 0;
const nextId = () => (updateId += 1);

const message = (from, text, chatId = CHAT, chatType = "supergroup") =>
  handleUpdate({
    update_id: nextId(),
    message: {
      message_id: nextId(),
      from: { id: from, is_bot: false, first_name: from === HERO ? "Игорь" : from === ADMIN ? "Орг" : "Гость" },
      chat: { id: chatId, type: chatType },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
    },
  });

const press = (data, chatId = CHAT) =>
  handleUpdate({
    update_id: nextId(),
    callback_query: {
      id: String(nextId()),
      from: { id: HERO, is_bot: false, first_name: "Игорь" },
      chat_instance: "ci",
      data,
      message: { message_id: 1, chat: { id: chatId, type: "supergroup" } },
    },
  });

const pressAs = (from, data, chatId = CHAT) =>
  handleUpdate({
    update_id: nextId(),
    callback_query: {
      id: String(nextId()),
      from: { id: from, is_bot: false, first_name: from === HERO ? "Игорь" : "Орг" },
      chat_instance: "ci",
      data,
      message: { message_id: 1, chat: { id: chatId, type: "supergroup" } },
    },
  });

const texts = () => calls.filter((c) => c.startsWith("MSG ")).map((c) => JSON.parse(c.slice(4)));
const reset = () => { calls.length = 0; };

const failures = [];
function expect(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== Защита от лишних нажатий (отдельный чат) ===");
const CHAT_MID = -100999;
await message(HERO, "/start", CHAT_MID);
reset();
await press("opt:5:1", CHAT_MID);
expect("перескок на будущий вопрос отклонён", calls.some((c) => c.includes("уже пройден")), calls.join(" | "));
reset();
await press("next:3", CHAT_MID);
expect("перескок «дальше» отклонён", calls.some((c) => c.includes("уже пройден")), calls.join(" | "));
reset();
await press("next:0", CHAT_MID);
expect("нельзя идти дальше без ответа", calls.some((c) => c.includes("Сначала выбери ответ")), calls.join(" | "));
reset();
await press("opt:0:1", CHAT_MID);
await press("opt:0:2", CHAT_MID);
expect("второй вариант после ответа отклонён", calls.some((c) => c.includes("уже выбран")), calls.join(" | "));
expect("после лишнего нажатия игра не сломалась", (await getSession(CHAT_MID, HERO))?.answers.length === 1);
expect("ответ сохранён как вариант Б", (await getSession(CHAT_MID, HERO))?.answers[0]?.optionKey === "Б");

console.log("\n=== Полный проход игры ===");
reset();
await message(HERO, "/start");
for (let i = 0; i < totalQuestions; i += 1) {
  await press(`opt:${i}:0`);
  await press(`next:${i}`);
}

const sent = texts();
const questionLines = sent.filter((m) => /· вопрос \d+ из \d+/.test(m.text));

expect("приветствие отправлено", sent[0]?.text.includes("Игорь, с днём рождения"));
expect(`вопросов отправлено ${totalQuestions}`, questionLines.length === totalQuestions, `получено ${questionLines.length}`);
expect("на каждом вопросе кнопки А/Б/В", questionLines.every((m) => m.buttons === "А | Б | В"));
expect("вопрос содержит 3 варианта", questionLines.every((m) => /А\..*\nБ\..*\nВ\./s.test(m.text)));
expect("категории в заголовках", new Set(questionLines.map((m) => m.text.split(" · ")[0])).size === 5);
expect("ответов зафиксировано 12", sent.filter((m) => m.text.startsWith("Выбрано:")).length === totalQuestions);
expect("реакция после каждого ответа", sent.some((m) => m.text.startsWith("Значит, сегодня будет громко")));
expect("кнопка следующего вопроса 11 раз", sent.filter((m) => m.buttons === "Следующий вопрос 🎯").length === totalQuestions - 1);
expect("кнопка финала 1 раз", sent.filter((m) => m.buttons === "Финал 🎁").length === 1);
expect("заглушка вместо видео", sent.some((m) => m.text.includes("Видео для этого варианта ещё не загружено")));
expect("финальный текст с именем", sent.some((m) => m.text.includes("Игорь, ты прошёл все 12 вопросов")));
expect("кнопка рестарта в финале", sent.some((m) => m.buttons === "Играть снова 🔄"));

const session = await getSession(CHAT, HERO);
expect("сессия finished", session?.finished === true);
expect("в сессии 12 ответов", session?.answers?.length === totalQuestions, `получено ${session?.answers?.length}`);
expect("ответы — вариант А", session?.answers?.every((a) => a.optionIndex === 0));

console.log("\n=== После финала ===");
reset();
await press("opt:11:2");
expect("кнопки после финала не работают", calls.some((c) => c.includes("завершена")), calls.join(" | "));

console.log("\n=== Гость не может играть ===");
reset();
await message(3, "/start");
expect("гость получил отказ", texts().some((m) => m.text.includes("Это игра для именинника")), calls.join(" | "));

console.log("\n=== Админка ===");
reset();
await message(3, "/admin_status");
expect("гость не попал в админку", texts().some((m) => m.text.includes("Админка доступна только организатору")));

reset();
await message(ADMIN, "/admin_status");
const status = texts().map((m) => m.text).join("\n");
expect("админ видит прогресс именинника", status.includes("Игорь (2)") && status.includes("завершена"));
expect("админ видит ответы", status.includes("q1: А. Шумная вечеринка"));
expect("счётчик видео 0/37", status.includes("Видео: 0/37"), status.slice(0, 200));
expect("список недостающих видео", status.includes("Не хватает (37)"));

reset();
await message(ADMIN, "/admin_video q1 Б BAACAgIAAxTEST");
expect("видео привязано к q1:Б", texts().some((m) => m.text.includes("Видео сохранено") && m.text.includes("Б. Узкий круг")), calls.join(" | "));

reset();
await message(ADMIN, "/admin_video final video BAACAgIAAxFINAL");
expect("финальное видео сохранено", texts().some((m) => m.text.includes("Финальное видео сохранено")));

reset();
await message(ADMIN, "/admin_video q99 А BAACAgIAAx");
expect("неизвестный вопрос отклонён", texts().some((m) => m.text.includes("не найден")));

reset();
await message(ADMIN, "/admin_preview");
const preview = texts().map((m) => m.text).join("\n");
expect("превью содержит все вопросы", preview.includes(getQuestion(11).text));
expect("превью содержит финальный текст", preview.includes("поздравления от нас"));

reset();
await message(ADMIN, "/admin");
expect("меню админки с кнопками", texts().some((m) => m.buttons?.includes("📊 Статус") && m.buttons.includes("♻️ Сбросить")));

reset();
await message(ADMIN, `/admin_reset ${CHAT}`);
expect("сессия сброшена", texts().some((m) => m.text.includes("Сессии в чате") && m.text.includes("сброшены")));
expect("сессия удалена из хранилища", (await getSession(CHAT, HERO)) === null);

console.log("\n=== Редактор контента: команды ===");
const baseQ1 = findQuestionById("q1").text;

reset();
await message(ADMIN, "/admin_q q1 text Как проводят дни рождения?");
expect("текст вопроса изменён", findQuestionById("q1").text === "Как проводят дни рождения?", texts().map((m) => m.text).join(" | "));

reset();
await message(ADMIN, "/admin_q q1 label А Совсем новая вечеринка");
expect("вариант ответа изменён", findQuestionById("q1").options[0].label === "Совсем новая вечеринка", findQuestionById("q1").options[0].label);

reset();
await message(ADMIN, "/admin_q q1 reaction А Будет громко и весело!");
expect("реакция изменена", findQuestionById("q1").options[0].reaction_text === "Будет громко и весело!", findQuestionById("q1").options[0].reaction_text);

reset();
await message(ADMIN, "/admin_set greeting Салют, {name}!");
expect("команда без аргументов не ломает бота", texts().some((m) => m.text.length > 0));

reset();
await message(ADMIN, "/admin_list");
expect("список показывает ключи правок", texts().some((m) => m.text.includes("q:q1:text")), texts().map((m) => m.text).join(" | "));

console.log("\n=== Редактор контента: кнопки ===");
reset();
await message(ADMIN, "/admin_edit");
expect("меню редактора открылось", texts().some((m) => m.text.includes("Что меняем")), texts().map((m) => m.text).join(" | "));

reset();
await pressAs(ADMIN, "ce:qtext");
expect("список вопросов для текста", texts().some((m) => m.buttons?.includes("q1 · ")), texts().map((m) => m.buttons).join(" | "));

reset();
await pressAs(ADMIN, "ce:q:q1:text");
expect("бот просит новый текст вопроса", texts().some((m) => m.text.includes("Пришли новый текст вопроса")), texts().map((m) => m.text).join(" | "));

reset();
await message(ADMIN, "Текст вопроса из кнопок");
expect("текст сохранён по кнопкам", findQuestionById("q1").text === "Текст вопроса из кнопок", findQuestionById("q1").text);

reset();
await pressAs(ADMIN, "ce:qlabel");
expect("список вопросов для варианта", texts().some((m) => m.buttons?.includes("q1 · ")), texts().map((m) => m.buttons).join(" | "));

reset();
await pressAs(ADMIN, "ce:q:q1:label");
expect("бот спрашивает, какой вариант", texts().some((m) => m.text.includes("Какой вариант меняем")), texts().map((m) => m.text).join(" | "));

reset();
await pressAs(ADMIN, "ce:q:q1:label:В");
expect("бот предлагает текущий вариант", texts().some((m) => m.text.includes("Пришли новый текст варианта")), texts().map((m) => m.text).join(" | "));

reset();
await message(ADMIN, "Вариант из кнопок");
expect("вариант сохранён по кнопкам", findQuestionById("q1").options[2].label === "Вариант из кнопок", findQuestionById("q1").options[2].label);

reset();
await pressAs(ADMIN, "ce:qvideo");
expect("список вопросов для видео", texts().some((m) => m.buttons?.includes("q1 · ")), texts().map((m) => m.buttons).join(" | "));

reset();
await pressAs(3, "ce:qtext");
expect("гость не попадает в редактор", !texts().some((m) => m.buttons?.includes("q1 · ")), texts().map((m) => m.text).join(" | "));

console.log("\n=== Редактор контента: имя именинника ===");
reset();
await pressAs(ADMIN, "ce:heroname");
expect("бот просит имя именинника", texts().some((m) => m.text.includes("имя именинника")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await message(ADMIN, "Игорь");
expect("имя именинника сохранено", texts().some((m) => m.text.includes("Игорь")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "adm:status");
expect("статус показывает именинника", texts().some((m) => m.text.includes("Именинник: Игорь")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "adm:preview");
expect("превью подставляет имя из настроек", texts().some((m) => m.text.includes("Игорь")), texts().map((m) => m.text).join(" | ").slice(0, 200));

console.log("\n=== Редактор контента: одиночные поля ===");
reset();
await pressAs(ADMIN, "ce:greeting");
expect("бот ждёт новое приветствие", texts().some((m) => m.text.includes("Пришли новое приветствие")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await message(ADMIN, "Привет, {name}! Начинаем 🎬");
expect("приветствие сохранено", (await currentGreeting()) === "Привет, {name}! Начинаем 🎬", await currentGreeting());

reset();
await pressAs(ADMIN, "ce:finalvideo");
expect("бот просит file_id финального видео", texts().some((m) => m.text.includes("file_id")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await message(ADMIN, "BAACAgIAAxFINALVIDEO");
expect("финальное видео сохранено по кнопкам", finalVideo() === "BAACAgIAAxFINALVIDEO", String(finalVideo()));

reset();
await pressAs(ADMIN, "ce:list");
expect("кнопка «что перекрыто» работает", texts().some((m) => m.text.includes("Ключи правок")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "ce:reset");
expect("кнопка сброса требует подтверждения", texts().some((m) => m.buttons?.includes("Да, сбросить всё")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "ce:reset:no");
expect("отмена сброса ничего не трогает", Object.keys(getOverrides()).length > 0 && texts().some((m) => m.text.includes("Ничего не сбросила")));

console.log("\n=== Редактор контента: приветствие и сброс ===");
reset();
await message(ADMIN, "/admin_set greeting Салют, {name}!");
await message(ADMIN, "/admin_preview");
expect("приветствие изменено", texts().some((m) => m.text.includes("Салют, Игорь!")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await message(ADMIN, "/admin_export");
expect("экспорт отправил файл", calls.some((c) => c.startsWith("sendDocument")), calls.join(" | ").slice(0, 200));

reset();
await message(ADMIN, "/admin_reset_content");
expect("правки сброшены", Object.keys(getOverrides()).length === 0, JSON.stringify(getOverrides()));
expect("контент вернулся к JSON", findQuestionById("q1").text === baseQ1, findQuestionById("q1").text);

console.log("\n=== Персональный тест: мастер в личке ===");
const DM = ADMIN;
const draftMessage = (from, text) => message(from, text, DM, "private");
const draftPress = (data) => pressAs(ADMIN, data, DM);

reset();
await draftMessage(ADMIN, "/newtest");
expect("бот предлагает шаблоны", texts().some((m) => m.buttons?.includes("Копия основной игры")), texts().map((m) => m.buttons).join(" | "));

reset();
await draftPress("qs:new:about");
expect("шаблон сразу готов к правке", texts().some((m) => m.text.includes("Черновик")) && texts().some((m) => m.buttons?.includes("Править вопрос")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await draftPress("qs:pick");
expect("бот показал список вопросов шаблона", texts().some((m) => m.buttons?.includes("1. ")), texts().map((m) => m.buttons).join(" | ").slice(0, 200));

reset();
await draftPress("qs:edit:0");
expect("бот показывает текущий текст вопроса", texts().some((m) => m.text.includes("Сейчас:")), texts().map((m) => m.text).join(" | ").slice(0, 200));

/* Один вопрос целиком: текст, варианты, реакции, видео. */
for (const value of ["Любимое занятие?", "Читать", "Гулять", "Спать"]) {
  await draftMessage(ADMIN, value);
}
for (const _ of [0, 1, 2]) await draftPress("qs:skip:reaction");
for (const _ of [0, 1, 2]) await draftPress("qs:skip:video");
const afterVideo = texts().map((m) => m.text).join("\n");
expect("после вопроса бот предлагает сохранить", afterVideo.includes("Черновик"), afterVideo.slice(0, 200));
reset();

/* Добираем вопросы до минимума и сохраняем. */
for (let n = 2; n <= 3; n += 1) {
  await draftPress("qs:more");
  await draftMessage(ADMIN, `Вопрос номер ${n}?`);
  await draftMessage(ADMIN, "Первый");
  await draftMessage(ADMIN, "Второй");
  await draftPress("qs:skip:reaction");
  await draftPress("qs:skip:reaction");
  await draftPress("qs:skip:video");
  await draftPress("qs:skip:video");
}

reset();
await draftPress("qs:preview");
const draftPreview = texts().map((m) => m.text).join("\n");
expect("превью черновика показывает вопросы", draftPreview.includes("Любимое занятие?") && draftPreview.includes("Вопрос номер 3?"), draftPreview.slice(0, 300));

reset();
await draftPress("qs:save");
const savedReply = texts().map((m) => m.text).join("\n");
const codeMatch = savedReply.match(/Код: (\d{6})/);
expect("бот выдал код из 6 цифр", Boolean(codeMatch), savedReply.slice(0, 300));
const TEST_CODE = codeMatch?.[1] ?? "";

reset();
await draftMessage(ADMIN, "/mylist");
expect("тест есть в списке с кодом", texts().some((m) => m.text.includes(TEST_CODE)), texts().map((m) => m.text).join(" | ").slice(0, 200));

console.log("\n=== Персональный тест: запуск по коду в группе ===");
/* Короткий тест на 3 вопроса создаём напрямую, чтобы прогон был быстрым. */
const SMALL_CODE = "902418";
await saveQuiz({
  code: SMALL_CODE,
  title: "Короткий тест",
  ownerId: ADMIN,
  ownerName: "Орг",
  questions: [
    { id: "s1", text: "Первый?", options: [{ label: "Да" }, { label: "Нет" }] },
    { id: "s2", text: "Второй?", options: [{ label: "Да" }, { label: "Нет" }] },
    { id: "s3", text: "Третий?", options: [{ label: "Да" }, { label: "Нет" }] },
  ],
  finalText: "Короткий тест закончен! 🎉",
  finalVideoFileId: null,
  createdAt: Date.now(),
});

reset();
await message(5, "1234567");
expect("неизвестный код игнорируется", texts().length === 0, calls.join(" | ").slice(0, 200));

reset();
await message(ADMIN, SMALL_CODE);
expect("код запустил тест", texts().some((m) => m.text.includes("Запускаю тест")), texts().map((m) => m.text).join(" | ").slice(0, 200));
expect("первый вопрос с кнопками А/Б", texts().some((m) => m.buttons?.includes("А") && m.buttons.includes("Б")), texts().map((m) => m.buttons).join(" | "));

reset();
await pressAs(3, "popt:0:0");
expect("гость не может отвечать", texts().length === 0, calls.join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "popt:0:1");
expect("автор кода ответил", texts().some((m) => m.text.includes("Выбрано: Б.")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "popt:0:2");
expect("второй ответ по вопросу отклонён", texts().length === 0, calls.join(" | ").slice(0, 200));

reset();
await pressAs(HERO, "pnext:0");
expect("именинник тоже может вести дальше", texts().some((m) => m.text.includes("вопрос 2 из 3")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(3, "popt:1:0");
expect("гость всё ещё не отвечает", texts().length === 0, calls.join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "popt:1:0");
await pressAs(ADMIN, "pnext:1");
await pressAs(ADMIN, "popt:2:1");
await pressAs(ADMIN, "pnext:2");
const finalTexts = texts().map((m) => m.text).join("\n");
expect("тест дошёл до финала", finalTexts.includes("Короткий тест закончен"), finalTexts.slice(0, 300));
expect("итоговые ответы видны всем", finalTexts.includes("Ваши ответы:") && finalTexts.includes("1. Б.") && finalTexts.includes("3. Б."), finalTexts.slice(0, 400));

reset();
await pressAs(ADMIN, "ptest:again");
expect("можно пройти ещё раз", texts().some((m) => m.text.includes("начинаем заново")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await pressAs(ADMIN, "ptest:stop");
expect("тест остановлен", texts().some((m) => m.text.includes("Тест остановлен")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await message(ADMIN, "/test_stop");
expect("повторная остановка не ломает бота", texts().some((m) => m.text.includes("активных тестов нет")), texts().map((m) => m.text).join(" | ").slice(0, 200));

reset();
await draftPress(`qs:del:${TEST_CODE}`);
expect("тест из мастера удаляется", !(await listOwnerQuizCodes(ADMIN)).includes(TEST_CODE), JSON.stringify(await listOwnerQuizCodes(ADMIN)));

reset();
await draftPress(`qs:del:${SMALL_CODE}`);
expect("короткий тест удаляется", !(await listOwnerQuizCodes(ADMIN)).includes(SMALL_CODE), JSON.stringify(await listOwnerQuizCodes(ADMIN)));

console.log("\n=== Приём видео в личке ===");
reset();
await handleUpdate({
  update_id: nextId(),
  message: {
    message_id: nextId(),
    from: { id: ADMIN, is_bot: false, first_name: "Орг" },
    chat: { id: ADMIN, type: "private" },
    video: { file_id: "BAACAgIAAxFROMVIDEO", file_size: 123 },
  },
});
const privateReply = texts().map((m) => m.text).join("\n");
expect("бот вернул file_id", privateReply.includes("BAACAgIAAxFROMVIDEO"));
expect("бот дал готовую команду", privateReply.includes("/admin_video q1 А BAACAgIAAxFROMVIDEO"));

console.log("\n=== Рестарт ===");
reset();
await message(HERO, "/start");
await press("restart");
expect("игра пошла заново с вопроса 1", texts().some((m) => /· вопрос 1 из 12/.test(m.text)));
const restarted = await getSession(CHAT, HERO);
expect("finished сброшен", restarted?.finished === false);
expect("ответы очищены", restarted?.answers?.length === 0);

console.log(`\n=== Итог: ${failures.length ? `❌ провалено ${failures.length}` : "✅ все e2e-проверки прошли"} ===`);
if (failures.length) console.error(failures.map((f) => `  - ${f}`).join("\n"));
console.log("");
process.exit(failures.length ? 1 : 0);
