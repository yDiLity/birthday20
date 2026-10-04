import { Telegraf, Markup } from "telegraf";
import { config, isAdmin, isHero, validate } from "./config.js";
import {
  content,
  questions,
  totalQuestions,
  getQuestion,
  findQuestionById,
  optionKey,
  optionIndexFromKey,
  OPTION_KEYS,
  fill,
  questionBlock,
  videoFor,
  finalVideo,
  applyOverrides,
  getOverrides,
  setOverride,
  clearAllOverrides,
  makeKey,
} from "./content.js";
import {
  getSession,
  saveSession,
  resetSession,
  listChatUserIds,
  getOverrides as loadOverrides,
  saveOverrides,
  getPending,
  savePending,
  clearPending,
  getQuiz,
  saveQuiz,
  deleteQuiz,
  listOwnerQuizCodes,
  getPersonalSession,
  savePersonalSession,
  clearPersonalSession,
  getDraft,
  saveDraft,
  clearDraft,
  pingRedis,
} from "./store.js";
import {
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  RECOMMENDED_MIN,
  RECOMMENDED_MAX,
  CODE_RE,
  TEMPLATES,
  emptyQuiz,
  cloneQuiz,
  normalizeQuiz,
  generateCode,
  quizQuestion,
  quizQuestionText,
  quizSummary,
  quizFromTemplate,
  templateList,
  defaultReaction,
} from "./quizzes.js";

const NEXT_LABEL = "Следующий вопрос 🎯";
const FINAL_LABEL = "Финал 🎁";
const RESTART_LABEL = "Играть снова 🔄";
const ADMIN_HINT =
  "Админка доступна только организатору.\nЕсли это ты — проверь ADMIN_ID в настройках Vercel (и /admin_id, чтобы узнать свой ID).";

let botInstance = null;
let telegramOverride = null;
let contentLoaded = false;

/** Точка подмены Telegram-клиента: используется в e2e-тестах (scripts/e2e.js). */
export function setTelegramClient(client) {
  telegramOverride = client;
  botInstance = null;
}

function createBot() {
  if (!config.botToken) throw new Error("BOT_TOKEN не задан — бот не может стартовать");
  const bot = new Telegraf(config.botToken);
  if (telegramOverride) bot.telegram = telegramOverride;

  bot.start(onStart);
  bot.command("admin", guard(onAdminMenu));
  bot.command("admin_help", guard(onAdminHelp));
  bot.command("admin_id", onAdminId);
  bot.command("admin_status", guard(onAdminStatus));
  bot.command("admin_video", guard(onAdminVideo));
  bot.command("admin_reset", guard(onAdminReset));
  bot.command("admin_preview", guard(onAdminPreview));
  bot.command("admin_edit", guard(onAdminEditMenu));
  bot.command("admin_q", guard(onAdminQuestion));
  bot.command("admin_set", guard(onAdminSet));
  bot.command("admin_list", guard(onAdminList));
  bot.command("admin_export", guard(onAdminExport));
  bot.command("admin_reset_content", guard(onAdminResetContent));
  bot.command("newtest", guard(onNewTest));
  bot.command("mylist", guard(onMyList));
  bot.command("newtest_save", guard(onDraftSaveCommand));
  bot.command("newtest_preview", guard(onDraftPreviewCommand));
  bot.command("newtest_cancel", guard(onDraftCancelCommand));
  bot.command("test_stop", guard(onTestStop));
  bot.on("callback_query", onCallbackQuery);
  bot.on("video", onVideoReceived);
  bot.on("message", onMessageRouter);

  return bot;
}

export function getBot() {
  if (!botInstance) botInstance = createBot();
  return botInstance;
}

/** Правки контента лежат в Redis; подтягиваем их один раз на инстанс. */
async function ensureContent() {
  if (contentLoaded) return;
  try {
    applyOverrides(await loadOverrides());
  } catch (error) {
    console.error("[bot] не смог загрузить правки контента:", error?.message || error);
  }
  contentLoaded = true;
}

async function persistOverride(key, value) {
  setOverride(key, value);
  await saveOverrides(getOverrides());
}

async function persistClearAll() {
  clearAllOverrides();
  await saveOverrides({});
}

export async function handleUpdate(update) {
  if (!update || typeof update !== "object") return;
  await ensureContent();
  await getBot().handleUpdate(update);
}

export function botInfo() {
  const problems = validate();
  return {
    tokenConfigured: Boolean(config.botToken),
    admins: config.adminIds,
    heroId: config.heroId,
    heroName: config.heroName,
    contentQuestions: totalQuestions,
    problems,
  };
}

function guard(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await safeReply(ctx, ADMIN_HINT);
      return;
    }
    await handler(ctx);
  };
}

async function safeReply(ctx, text, extra) {
  try {
    return await ctx.reply(text, extra);
  } catch (error) {
    console.error("[bot] не смог ответить:", error?.message || error);
    return null;
  }
}

async function send(chatId, text, extra) {
  try {
    return await getBot().telegram.sendMessage(chatId, text, extra);
  } catch (error) {
    console.error("[bot] не смог отправить сообщение:", error?.message || error);
    return null;
  }
}

function navKeyboard(callbackData, label) {
  return Markup.inlineKeyboard([[Markup.button.callback(label, callbackData)]]).reply_markup;
}

function optionsKeyboard(index) {
  return Markup.inlineKeyboard(
    getQuestion(index).options.map((option, i) => [
      Markup.button.callback(option.btn || optionKey(i), `opt:${index}:${i}`),
    ]),
  ).reply_markup;
}

function heroNameOf(session) {
  return session?.heroName || config.heroName;
}

function newSession(chatId, user) {
  return {
    chatId,
    userId: user.id,
    userName: [user.first_name, user.last_name].filter(Boolean).join(" "),
    heroName: config.heroName,
    questionIndex: 0,
    answers: [],
    finished: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/* ------------------------------ игровой цикл ------------------------------ */

async function onStart(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;

  if (!isHero(ctx.from.id)) {
    await safeReply(ctx, `Это игра для именинника — ${config.heroName}. Подождём его! 🎂`);
    return;
  }

  const existing = await getSession(chatId, ctx.from.id);

  if (existing?.finished) {
    if (config.allowRestart) {
      await safeReply(ctx, `Ты уже прошёл игру, ${heroNameOf(existing)}! Можно пройти заново 🙂`, {
        reply_markup: navKeyboard("restart", RESTART_LABEL),
      });
    } else {
      await safeReply(ctx, `Игра уже пройдена, ${heroNameOf(existing)}! Это было красиво 🎉`);
    }
    return;
  }

  const session = existing ?? newSession(chatId, ctx.from);
  await saveSession(session);

  if (!existing) {
    await send(chatId, fill(content.greeting, { name: heroNameOf(session), count: totalQuestions }));
  }

  await sendQuestion(chatId, session);
}

async function sendQuestion(chatId, session) {
  const question = getQuestion(session.questionIndex);
  if (!question) {
    await sendFinal(chatId, session);
    return;
  }

  const text = [
    `${question.categoryTitle} · вопрос ${session.questionIndex + 1} из ${totalQuestions}`,
    "",
    question.text,
    "",
    ...question.options.map((option, i) => `${optionKey(i)}. ${option.label}`),
  ].join("\n");

  await send(chatId, text, { reply_markup: optionsKeyboard(session.questionIndex) });
}

async function sendVideoOrStub(chatId, fileId, stubText, replyMarkup) {
  if (fileId) {
    try {
      await getBot().telegram.sendVideo(chatId, fileId, replyMarkup ? { reply_markup: replyMarkup } : undefined);
      return true;
    } catch (error) {
      console.error("[bot] видео не отправилось:", error?.message || error);
    }
  }
  await send(chatId, stubText, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  return false;
}

async function answerQuestion(ctx, session, question, optionIndex) {
  const chatId = ctx.chat.id;
  const option = question.options[optionIndex];
  const key = optionKey(optionIndex);

  session.answers.push({
    questionId: question.id,
    optionIndex,
    optionKey: key,
    label: option.label,
    at: Date.now(),
  });
  await saveSession(session);

  await safeAnswerCb(ctx, `Ответ принят: ${key} 🎯`);

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    /* сообщение могло устареть — не критично */
  }

  await send(chatId, `Выбрано: ${key}. ${option.label}`);
  await send(chatId, option.reaction_text);

  const isLast = session.questionIndex >= totalQuestions - 1;
  const markup = navKeyboard(`next:${session.questionIndex}`, isLast ? FINAL_LABEL : NEXT_LABEL);
  await sendVideoOrStub(chatId, videoFor(question, optionIndex), fill(content.no_video_text, { name: heroNameOf(session) }), markup);
}

async function goNext(ctx, session, currentIndex) {
  const chatId = ctx.chat.id;
  session.questionIndex = currentIndex + 1;

  if (session.questionIndex >= totalQuestions) {
    await saveSession(session);
    await safeAnswerCb(ctx, "Финал! 🎉");
    await sendFinal(chatId, session);
    return;
  }

  await saveSession(session);
  await safeAnswerCb(ctx, "Летим дальше! 🎯");
  await sendQuestion(chatId, session);
}

async function sendFinal(chatId, session) {
  if (!session.finished) {
    session.finished = true;
    session.finishedAt = Date.now();
    await saveSession(session);
  }

  const fileId = finalVideo();
  await sendVideoOrStub(chatId, fileId, "🎬 Финальное видео ещё не загружено — но мы всё равно поздравляем!", null);

  await send(chatId, fill(content.final_text, { name: heroNameOf(session), count: totalQuestions }), {
    reply_markup: config.allowRestart
      ? navKeyboard("restart", RESTART_LABEL)
      : undefined,
  });
}

async function restart(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;
  if (!isHero(ctx.from.id)) {
    await safeAnswerCb(ctx, "Только именинник 🙂", { show_alert: true });
    return;
  }

  await resetSession(chatId, ctx.from.id);
  const session = newSession(chatId, ctx.from);
  await saveSession(session);

  await safeAnswerCb(ctx, "Начинаем заново! 🎉");
  await send(chatId, fill(content.greeting, { name: heroNameOf(session), count: totalQuestions }));
  await sendQuestion(chatId, session);
}

/* ------------------------------ callback query ------------------------------ */

async function safeAnswerCb(ctx, text, extra) {
  try {
    return await ctx.answerCbQuery(text, extra);
  } catch (error) {
    console.error("[bot] answerCbQuery:", error?.message || error);
    return null;
  }
}

async function onCallbackQuery(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data.startsWith("qs:")) {
    await handleDraftCallback(ctx, data);
    return;
  }

  if (data.startsWith("popt:") || data.startsWith("pnext:") || data.startsWith("ptest:")) {
    await handlePersonalCallback(ctx, data);
    return;
  }

  if (data.startsWith("adm:")) {
    if (!isAdmin(ctx.from?.id)) {
      await safeAnswerCb(ctx, "Нет доступа", { show_alert: true });
      return;
    }
    await handleAdminCallback(ctx, data);
    return;
  }

  if (data.startsWith("ce:")) {
    if (!isAdmin(ctx.from?.id)) {
      await safeAnswerCb(ctx, "Нет доступа", { show_alert: true });
      return;
    }
    await handleContentCallback(ctx, data);
    return;
  }

  if (data === "restart") {
    await restart(ctx);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;

  const session = await getSession(chatId, ctx.from.id);
  if (!session) {
    await safeAnswerCb(ctx, "Игра не запущена — напиши /start 🎯", { show_alert: true });
    return;
  }
  if (session.finished) {
    await safeAnswerCb(ctx, "Игра уже завершена 🎉", { show_alert: true });
    return;
  }
  if (!isHero(ctx.from.id)) {
    await safeAnswerCb(ctx, "Кнопки нажимает именинник 🙂", { show_alert: true });
    return;
  }

  const [action, indexRaw, optionRaw] = data.split(":");
  const index = Number(indexRaw);

  if (!Number.isInteger(index) || session.questionIndex !== index) {
    await safeAnswerCb(ctx, "Этот вопрос уже пройден");
    return;
  }

  const question = getQuestion(index);
  if (!question) return;

  if (action === "opt") {
    const optionIndex = Number(optionRaw);
    if (!Number.isInteger(optionIndex) || !question.options[optionIndex]) {
      await safeAnswerCb(ctx, "Такого варианта нет");
      return;
    }
    if (session.answers.some((answer) => answer.questionId === question.id)) {
      await safeAnswerCb(ctx, "Ответ уже выбран 🙂", { show_alert: true });
      return;
    }
    await answerQuestion(ctx, session, question, optionIndex);
    return;
  }

  if (action === "next") {
    if (!session.answers.some((answer) => answer.questionId === question.id)) {
      await safeAnswerCb(ctx, "Сначала выбери ответ 🙂", { show_alert: true });
      return;
    }
    await goNext(ctx, session, index);
  }
}

/* --------------------------------- админка --------------------------------- */

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Изменить тексты", "adm:edit"), Markup.button.callback("📊 Статус", "adm:status")],
    [Markup.button.callback("👀 Прогнать сценарий текстом", "adm:preview")],
    [Markup.button.callback("♻️ Сбросить игру в этом чате", "adm:reset")],
    [Markup.button.callback("ℹ️ Команды", "adm:help")],
  ]).reply_markup;
}

const ADMIN_COMMANDS = [
  "/admin — меню",
  "/admin_edit — пошаговое изменение вопросов, ответов, реакций и видео кнопками",
  "/admin_q <q_id> text <новый текст> — изменить вопрос",
  "/admin_q <q_id> label <А/Б/В> <новый вариант> — изменить ответ",
  "/admin_q <q_id> reaction <А/Б/В> <новая реакция> — изменить реакцию",
  "/admin_video <q_id> <А/Б/В> <file_id> — привязать видео к варианту",
  "/admin_video final video <file_id> — финальное видео",
  "/admin_set <greeting|final|no_video> <текст> — приветствие, финальный текст, текст-заглушка",
  "/admin_list — текущий сценарий текстом",
  "/admin_export — весь контент в JSON (бэкап)",
  "/admin_status — кто на каком вопросе + каких видео не хватает",
  "/admin_reset [chat_id] — сбросить сессию (текущий чат по умолчанию)",
  "/admin_preview — весь сценарий текстом в этот чат",
  "/admin_reset_content — откатить все правки текстов к варианту из репозитория",
  "/admin_id — твой Telegram ID",
];

const FIELD_LABELS = {
  text: "текст вопроса",
  label: "вариант ответа",
  reaction: "реакцию",
  video: "видео",
};

function editMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Текст вопроса", "ce:qtext"), Markup.button.callback("Вариант ответа", "ce:qlabel")],
    [Markup.button.callback("Реакцию", "ce:qreaction"), Markup.button.callback("Видео", "ce:qvideo")],
    [Markup.button.callback("Приветствие", "ce:greeting"), Markup.button.callback("Финальный текст", "ce:finaltext")],
    [Markup.button.callback("Финальное видео", "ce:finalvideo"), Markup.button.callback("Текст-заглушку", "ce:novideo")],
    [Markup.button.callback("Показать сценарий", "ce:list"), Markup.button.callback("Экспорт в JSON", "ce:export")],
    [Markup.button.callback("♻️ Откатить все правки", "ce:reset")],
  ]).reply_markup;
}

async function onAdminMenu(ctx) {
  await safeReply(ctx, "Админка:", { reply_markup: adminKeyboard() });
}

async function onAdminHelp(ctx) {
  await safeReply(ctx, ADMIN_COMMANDS.join("\n"));
}

async function onAdminId(ctx) {
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  await safeReply(ctx, `Твой Telegram ID: ${ctx.from.id}\nИмя: ${name}\nЭто значение для ADMIN_ID.`);
}

async function handleAdminCallback(ctx, data) {
  const action = data.slice(4);

  if (action === "status") {
    await safeAnswerCb(ctx);
    await onAdminStatus(ctx);
    return;
  }
  if (action === "reset") {
    await safeAnswerCb(ctx);
    await resetChat(ctx, ctx.chat?.id);
    return;
  }
  if (action === "preview") {
    await safeAnswerCb(ctx);
    await onAdminPreview(ctx);
    return;
  }
  if (action === "edit") {
    await safeAnswerCb(ctx);
    await onAdminEditMenu(ctx);
    return;
  }
  if (action === "help") {
    await safeAnswerCb(ctx);
    await onAdminHelp(ctx);
  }
}

async function onAdminStatus(ctx) {
  const chatId = ctx.chat?.id;
  const redisOk = await pingRedis();
  const userIds = await listChatUserIds(chatId);
  const sessions = (await Promise.all(userIds.map((id) => getSession(chatId, id)))).filter(Boolean);

  const lines = [
    `Чат: ${chatId}`,
    `Redis: ${redisOk ? "подключён ✅" : "недоступен ⚠️ (сессия в памяти)"}`,
    `Вопросов в сценарии: ${totalQuestions}`,
    `Правок контента: ${Object.keys(getOverrides()).length}`,
    `Сессий: ${sessions.length}`,
  ];

  if (!sessions.length) {
    lines.push("Пока никто не играл.");
  }

  for (const session of sessions) {
    const when = session.finished
      ? "завершена 🎉"
      : `вопрос ${Math.min(session.questionIndex + 1, totalQuestions)}/${totalQuestions}`;
    const ago = session.updatedAt ? Math.max(0, Math.round((Date.now() - session.updatedAt) / 60000)) : null;
    lines.push(
      `• ${session.userName || session.userId} (${session.userId}): ${when}, ответов ${session.answers?.length ?? 0}${ago !== null ? `, обновлён ${ago} мин назад` : ""}`,
    );
    if (session.answers?.length) {
      lines.push(
        session.answers.map((a) => `   ${a.questionId}: ${a.optionKey}. ${a.label}`).join("\n"),
      );
    }
  }

  const missing = [];
  let ready = 0;
  for (const question of questions) {
    for (let i = 0; i < question.options.length; i += 1) {
      if (videoFor(question, i)) ready += 1;
      else missing.push(`${question.id}:${optionKey(i)}`);
    }
  }
  if (finalVideo()) ready += 1;
  else missing.push("final");

  const total = totalQuestions * OPTION_KEYS.length + 1;
  lines.push("", `Видео: ${ready}/${total} загружено`);
  if (missing.length) {
    lines.push(`Не хватает (${missing.length}): ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", …" : ""}`);
  }

  await safeReply(ctx, lines.join("\n"));
}

async function onAdminVideo(ctx) {
  const [questionId, optionRaw, fileId, ...rest] = String(ctx.message?.text ?? "")
    .split(/\s+/)
    .slice(1);

  if (!questionId || !optionRaw || !fileId || rest.length) {
    await safeReply(
      ctx,
      [
        "Формат:",
        "/admin_video q1 А BAACAgIAAx...",
        "/admin_video final video BAACAgIAAx...",
        "",
        `Вопросы: ${questions.map((q) => q.id).join(", ")}`,
        "Варианты: А / Б / В (или 1 / 2 / 3)",
      ].join("\n"),
    );
    return;
  }

  if (questionId.toLowerCase() === "final") {
    await persistOverride(makeKey("final", null, "video"), fileId);
    await safeReply(ctx, `Финальное видео сохранено ✅\n${fileId}`);
    return;
  }

  const question = findQuestionById(questionId);
  if (!question) {
    await safeReply(ctx, `Вопрос «${questionId}» не найден. Доступны: ${questions.map((q) => q.id).join(", ")}`);
    return;
  }

  const optionIndex = optionIndexFromKey(optionRaw);
  if (optionIndex === null || !question.options[optionIndex]) {
    await safeReply(ctx, `Вариант «${optionRaw}» не найден. Используй А, Б или В.`);
    return;
  }

  await persistOverride(makeKey("q", question.id, "video", optionKey(optionIndex)), fileId);
  await safeReply(
    ctx,
    [
      `Видео сохранено ✅`,
      `${question.id} · ${optionKey(optionIndex)}. ${question.options[optionIndex].label}`,
      `${question.text}`,
      `file_id: ${fileId}`,
    ].join("\n"),
  );
}

/* ------------------- изменение текстов: команды и кнопки ------------------- */

const SINGLETON_FIELDS = {
  greeting: {
    label: "приветствие",
    key: () => makeKey("greeting", null, "text"),
    current: () => content.greeting,
    hint: "Пришли новое приветствие. {name} — имя именинника, {count} — количество вопросов.",
  },
  final_text: {
    label: "финальный текст",
    key: () => makeKey("final", null, "text"),
    current: () => content.final_text,
    hint: "Пришли новый финальный текст. {name} — имя именинника, {count} — количество вопросов.",
  },
  final_video: {
    label: "финальное видео",
    key: () => makeKey("final", null, "video"),
    current: () => finalVideo() ?? "не задано",
    hint: "Пришли file_id финального видео (или отправь видео боту в личку — он вернёт file_id).",
  },
  no_video: {
    label: "текст-заглушка",
    key: () => makeKey("no_video", null, "text"),
    current: () => content.no_video_text,
    hint: "Этот текст бот покажет вместо видео, если видео ещё не загружено.",
  },
};

function questionButtons(field) {
  const rows = [];
  for (let i = 0; i < questions.length; i += 2) {
    rows.push(
      questions
        .slice(i, i + 2)
        .map((question) => Markup.button.callback(`${question.id} · ${question.categoryTitle.slice(0, 12)}`, `ce:q:${question.id}:${field}`)),
    );
  }
  return Markup.inlineKeyboard(rows).reply_markup;
}

async function onAdminEditMenu(ctx) {
  await clearPending(ctx.from.id, ctx.chat?.id);
  await safeReply(ctx, "Что меняем?", { reply_markup: editMenuKeyboard() });
}

async function onAdminList(ctx) {
  const overrides = getOverrides();
  const lines = [`Ключи правок (${Object.keys(overrides).length}):`];

  if (!Object.keys(overrides).length) {
    lines.push("Правок нет — используется content/questions.json.");
  } else {
    for (const [key, value] of Object.entries(overrides)) {
      const short = String(value).length > 60 ? `${String(value).slice(0, 60)}…` : String(value);
      lines.push(`• ${key} = ${short}`);
    }
  }

  lines.push("", `Вопросы (${totalQuestions}):`);
  for (const question of questions) {
    const filled = question.options.filter((option) => option.video_file_id).length;
    lines.push(`${question.id}. ${question.categoryTitle} — ${question.text}`);
    lines.push(`   видео: ${filled}/${question.options.length}`);
  }

  lines.push(`Финальное видео: ${finalVideo() ?? "не задано"}`);
  lines.push(`Всего видео нужно: ${totalQuestions * OPTION_KEYS.length + (finalVideo() ? 0 : 1)}`);

  for (const chunk of chunkText(lines.join("\n"))) await send(ctx.chat.id, chunk);
}

async function onAdminExport(ctx) {
  const json = JSON.stringify({ ...content, _overrides: getOverrides() }, null, 2);
  const chunks = chunkText(json);
  if (chunks.length === 1) {
    await safeReply(ctx, chunks[0]);
    return;
  }
  await safeReply(ctx, `Контент большой (${chunks.length} сообщения), отправляю файлом и первым куском.`);
  await sendDocument(ctx.chat.id, Buffer.from(json, "utf8"), "content-backup.json");
  await safeReply(ctx, chunks[0]);
}

async function sendDocument(chatId, buffer, filename) {
  try {
    await getBot().telegram.sendDocument(chatId, buffer, { filename });
    return true;
  } catch (error) {
    console.error("[bot] не смог отправить файл:", error?.message || error);
    return false;
  }
}

async function onAdminQuestion(ctx) {
  const parts = String(ctx.message?.text ?? "").split(/\s+/).slice(1);
  const [questionId, fieldRaw, ...rest] = parts;
  const field = String(fieldRaw ?? "").toLowerCase();

  if (!questionId || !["text", "label", "reaction"].includes(field) || !rest.length) {
    await safeReply(
      ctx,
      [
        "Формат:",
        "/admin_q q1 text Как провожат дни рождения?",
        "/admin_q q1 label А Шумная вечеринка",
        "/admin_q q1 reaction А Значит, сегодня будет громко!",
        "",
        `Вопросы: ${questions.map((q) => q.id).join(", ")}`,
      ].join("\n"),
    );
    return;
  }

  const question = findQuestionById(questionId);
  if (!question) {
    await safeReply(ctx, `Вопрос «${questionId}» не найден. Доступны: ${questions.map((q) => q.id).join(", ")}`);
    return;
  }

  if (field === "text") {
    await persistOverride(makeKey("q", question.id, "text"), rest.join(" ").trim());
    await safeReply(ctx, `Вопрос обновлён ✅\n${findQuestionById(question.id).text}`);
    return;
  }

  const index = optionIndexFromKey(rest[0] ?? "");
  if (index === null || !question.options[index]) {
    await safeReply(ctx, "Укажи вариант: /admin_q q1 label А Новый вариант");
    return;
  }

  const value = rest.slice(1).join(" ").trim();
  if (!value) {
    await safeReply(ctx, "Пришли текст после варианта.");
    return;
  }

  await persistOverride(makeKey("q", question.id, field, optionKey(index)), value);
  const updated = findQuestionById(question.id);
  await safeReply(
    ctx,
    field === "label"
      ? `Вариант обновлён ✅\n${optionKey(index)}. ${updated.options[index].label}`
      : `Реакция обновлена ✅\n${optionKey(index)}. ${updated.options[index].label} → ${updated.options[index].reaction_text}`,
  );
}

async function onAdminSet(ctx) {
  const [, fieldRaw, ...rest] = String(ctx.message?.text ?? "").split(/\s+/);
  const field = String(fieldRaw ?? "").toLowerCase();
  const target = SINGLETON_FIELDS[field];

  if (!target) {
    await safeReply(ctx, `Поля: ${Object.keys(SINGLETON_FIELDS).join(", ")}.\nПример: /admin_set greeting {name}, с днём рождения! 🎂`);
    return;
  }

  const value = rest.join(" ").trim();
  if (!value) {
    await safeReply(ctx, `Пришли новый текст.\n${target.hint}`);
    return;
  }

  await persistOverride(target.key(), value);
  await safeReply(ctx, `Сохранено ✅\n${value}`);
}

async function onAdminResetContent(ctx) {
  const count = Object.keys(getOverrides()).length;
  await persistClearAll();
  await safeReply(ctx, `Откатил правки (${count}) к варианту из репозитория ✅`);
}

/* Пошаговое редактирование: ждём следующее сообщение админа как новое значение. */

async function startPending(ctx, state) {
  await savePending(ctx.from.id, ctx.chat.id, state);
}

async function onAdminPendingValue(ctx) {
  if (!isAdmin(ctx.from?.id)) return;
  const text = String(ctx.message?.text ?? "");
  if (!text.trim()) return;
  if (text.startsWith("/")) return;

  const chatId = ctx.chat?.id;
  const state = await getPending(ctx.from.id, chatId);
  if (!state) return;

  await clearPending(ctx.from.id, chatId);
  const value = text.trim();

  if (state.kind === "singleton") {
    await persistOverride(state.key, value);
    const target = SINGLETON_FIELDS[state.field];
    await safeReply(ctx, `Сохранено ✅\n${target?.current() ?? value}`);
    return;
  }

  const question = findQuestionById(state.questionId);
  if (!question) {
    await safeReply(ctx, `Вопрос «${state.questionId}» не найден.`);
    return;
  }

  if (state.field === "text") {
    await persistOverride(makeKey("q", question.id, "text"), value);
    await safeReply(ctx, `Вопрос обновлён ✅\n${findQuestionById(question.id).text}`);
    return;
  }

  if (state.field === "video") {
    await persistOverride(makeKey("q", question.id, "video", state.optionKey), value);
    await safeReply(ctx, `Видео для ${question.id}:${state.optionKey} сохранено ✅\n${value}`);
    return;
  }

  const index = optionIndexFromKey(state.optionKey);
  if (index === null || !question.options[index]) {
    await safeReply(ctx, "Не понял, какой вариант. Начни заново: /admin_edit");
    return;
  }
  await persistOverride(makeKey("q", question.id, state.field, state.optionKey), value);
  const updated = findQuestionById(question.id);
  await safeReply(
    ctx,
    state.field === "label"
      ? `Вариант обновлён ✅\n${state.optionKey}. ${updated.options[index].label}`
      : `Реакция обновлён ✅\n${state.optionKey}. ${updated.options[index].label} → ${updated.options[index].reaction_text}`,
  );
}

async function handleContentCallback(ctx, data) {
  const action = data.slice(3);

  if (["qtext", "qlabel", "qreaction", "qvideo"].includes(action)) {
    const field = action.slice(1);
    await safeAnswerCb(ctx);
    const labels = {
      text: "Какой вопрос меняем?",
      label: "В каком вопросе меняем вариант ответа?",
      reaction: "В каком вопросе меняем реакцию?",
      video: "В какой вопрос загружаем видео?",
    };
    await safeReply(ctx, `${labels[field]}\n\nПришли новый ${FIELD_LABELS[field]} следующим сообщением.`, {
      reply_markup: questionButtons(field),
    });
    return;
  }

  if (action.startsWith("q:")) {
    const [, questionId, field, optionRaw] = action.split(":");
    const question = findQuestionById(questionId);
    await safeAnswerCb(ctx);
    if (!question) {
      await safeReply(ctx, `Вопрос «${questionId}» не найден.`);
      return;
    }

    if (!optionRaw) {
      if (field === "text" || field === "video") {
        await startPending(ctx, { kind: "question", questionId: question.id, field, optionKey: null });
        await safeReply(
          ctx,
          field === "text"
            ? `Вопрос «${question.id}»:\n${question.text}\n\nПришли новый текст вопроса.`
            : `Пришли file_id для ${question.id}.\n(Или отправь видео боту в личку — он вернёт file_id готовой командой.)`,
        );
        return;
      }

      await safeReply(ctx, `Вопрос «${question.id}»: ${question.text}\n\nКакой вариант меняем?`, {
        reply_markup: Markup.inlineKeyboard(
          question.options.map((option, i) => [
            Markup.button.callback(
              `${optionKey(i)}. ${String(option.label).slice(0, 26)}`,
              `ce:q:${question.id}:${field}:${optionKey(i)}`,
            ),
          ]),
        ).reply_markup,
      });
      return;
    }

    const index = optionIndexFromKey(optionRaw);
    if (index === null || !question.options[index]) {
      await safeReply(ctx, `Вариант «${optionRaw}» не найден.`);
      return;
    }

    await startPending(ctx, { kind: "question", questionId: question.id, field, optionKey: optionKey(index) });
    await safeReply(
      ctx,
      [
        `${question.id} · ${optionKey(index)}. ${question.options[index].label}`,
        `${question.text}`,
        "",
        field === "label"
          ? "Пришли новый текст варианта."
          : `Сейчас: ${question.options[index].reaction_text}\n\nПришли новую реакцию.`,
      ].join("\n"),
    );
    return;
  }

  if (action === "greeting" || action === "finaltext" || action === "finalvideo" || action === "novideo") {
    const field = action === "finaltext" ? "final_text" : action === "finalvideo" ? "final_video" : action === "novideo" ? "no_video" : "greeting";
    const target = SINGLETON_FIELDS[field];
    await safeAnswerCb(ctx);
    if (!target) {
      await safeReply(ctx, `Поле «${field}» недоступно для правки.`);
      return;
    }
    await startPending(ctx, { kind: "singleton", field, key: target.key() });
    await safeReply(ctx, `${target.hint}\n\nСейчас: ${target.current()}`);
    return;
  }

  if (action === "list") {
    await safeAnswerCb(ctx);
    await onAdminList(ctx);
    return;
  }

  if (action === "export") {
    await safeAnswerCb(ctx);
    await onAdminExport(ctx);
    return;
  }

  if (action === "reset") {
    const count = Object.keys(getOverrides()).length;
    if (!count) {
      await safeAnswerCb(ctx, "Правок и так нет", { show_alert: true });
      return;
    }
    await safeAnswerCb(ctx, "Нужно подтверждение", { show_alert: true });
    await safeReply(ctx, `Сбросить все правки (${count})? Их можно будет вернуть только вручную.`, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("Да, сбросить всё", "ce:reset:yes"), Markup.button.callback("Отмена", "ce:reset:no")],
      ]).reply_markup,
    });
    return;
  }

  if (action === "reset:yes") {
    await safeAnswerCb(ctx, "Откатываю все правки", { show_alert: true });
    await persistClearAll();
    await safeReply(ctx, "Все правки откатились к варианту из репозитория ✅", { reply_markup: editMenuKeyboard() });
    return;
  }

  if (action === "reset:no") {
    await safeAnswerCb(ctx, "Отменила", { show_alert: true });
    await safeReply(ctx, "Ничего не сбросила ✅", { reply_markup: editMenuKeyboard() });
  }
}

async function resetChat(ctx, chatId) {
  if (!chatId) {
    await safeReply(ctx, "Укажи chat_id: /admin_reset -1001234567890");
    return;
  }
  const userIds = await listChatUserIds(chatId);
  await Promise.all(userIds.map((id) => resetSession(chatId, id)));
  await safeReply(ctx, `Сессии в чате ${chatId} сброшены (${userIds.length}).`);
}

async function onAdminReset(ctx) {
  const [, chatIdRaw] = String(ctx.message?.text ?? "").split(/\s+/).slice(1);
  const target = Number(chatIdRaw);
  await resetChat(ctx, Number.isFinite(target) && target ? target : ctx.chat?.id);
}

function chunkText(text, limit = 3800) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function onAdminPreview(ctx) {
const chatId = ctx.chat?.id;
  const blocks = [
    `ПРЕДПРОСМОТР СЦЕНАРИЯ (${totalQuestions} вопросов)`,
    "",
    `Приветствие:`,
    fill(content.greeting, { name: config.heroName, count: totalQuestions }),
    "",
    ...questions.map((_, index) => questionBlock(index)),
    "",
    `Финал:`,
    fill(content.final_text, { name: config.heroName, count: totalQuestions }),
  ];

  await safeReply(ctx, "Отправляю сценарий текстом…");
  for (const chunk of chunkText(blocks.join("\n"))) {
    await send(chatId, chunk);
  }
  await safeReply(ctx, `Готово: ${questions.length} вопросов, ${totalQuestions * OPTION_KEYS.length} видео-реакций.`);
}

/* --------------------- персональные тесты: мастер и коды ------------------- */

/*
 * Сценарий: в личке админ собирает тест пошагово (или берёт шаблон), жмёт «Сохранить»,
 * бот выдаёт код из цифр. В группе кто-то отправляет код — бот запускает этот тест,
 * отвечает тот, кто ввёл код, или именинник; ответы видят все.
 */

const SKIP = "—";
const optionLetter = (index) => ["А", "Б", "В"][index] ?? String(index + 1);

function draftQuestionOf(draft) {
  return draft?.quiz?.questions?.[draft.qi] ?? null;
}

function draftStepKeyboard(draft) {
  const question = draftQuestionOf(draft);
  const count = draft.quiz.questions.length;

  if (draft.step === "reaction") {
    return Markup.inlineKeyboard([
      [Markup.button.callback("⏭ Стандартная реакция", `qs:skip:reaction`)],
      [Markup.button.callback(`🎬 Видео ${optionLetter(draft.oi)} (file_id)`, "qs:noop")],
    ]).reply_markup;
  }
  if (draft.step === "video") {
    return Markup.inlineKeyboard([[Markup.button.callback("⏭ Без видео", "qs:skip:video")]]).reply_markup;
  }
  if (draft.step === "ready") {
    const canSave = count >= MIN_QUESTIONS;
    const rows = [
      [Markup.button.callback("➕ Ещё вопрос", "qs:more"), Markup.button.callback("👁 Превью", "qs:preview")],
    ];
    if (count) rows.splice(1, 0, [Markup.button.callback("✏️ Править вопрос", "qs:pick")]);
    rows.push([
      Markup.button.callback(
        canSave ? `💾 Сохранить и получить код (${count})` : `💾 Сохранить (минимум ${MIN_QUESTIONS})`,
        "qs:save",
      ),
    ]);
    rows.push([Markup.button.callback("✖️ Отменить", "qs:cancel")]);
    return Markup.inlineKeyboard(rows).reply_markup;
  }
  return undefined;
}

async function askDraftStep(ctx, draft) {
  const question = draftQuestionOf(draft);
  const count = draft.quiz.questions.length;

  if (draft.step === "title") {
    await safeReply(ctx, "Как называется тест? Например: «Тест про Игоря»");
    return;
  }

  if (draft.step === "qtext") {
    const total = draft.quiz.questions.length;
    const tip =
      draft.qi === 0 && !question?.text
        ? `Первая задача: ${MIN_QUESTIONS}+ вопросов (удобно ${RECOMMENDED_MIN}–${RECOMMENDED_MAX}).`
        : `Вопрос ${draft.qi + 1} из ${total || draft.qi + 1}. Всего можно до ${MAX_QUESTIONS}.`;
    const current = question?.text ? `\n\nСейчас: ${question.text}` : "";
    await safeReply(ctx, `${tip}${current}\n\nПришли новый текст вопроса («—» — оставить как есть).`, {
      reply_markup: draftStepKeyboard(draft),
    });
    return;
  }

  if (draft.step === "opt") {
    const letter = optionLetter(draft.oi);
    await safeReply(ctx, `Вопрос ${draft.qi + 1}: «${question.text}»\n\nВариант ${letter}. Пришли текст ответа${draft.oi === 0 ? "" : " (или «—», если вариант не нужен)"}.`, {
      reply_markup: draftStepKeyboard(draft),
    });
    return;
  }

  if (draft.step === "reaction") {
    const letter = optionLetter(draft.oi);
    const option = question.options[draft.oi];
    await safeReply(
      ctx,
      `Реакция на ${letter} («${option.label}»).\nСейчас: ${option.reaction_text}\n\nПришли новый текст реакции или «${SKIP}» — оставлю стандартный.`,
      { reply_markup: draftStepKeyboard(draft) },
    );
    return;
  }

  if (draft.step === "video") {
    const letter = optionLetter(draft.oi);
    await safeReply(
      ctx,
      `Видео-реакция на ${letter} («${question.options[draft.oi].label}»).\nПришли file_id или само видео — подставлю. «${SKIP}» — без видео.`,
      { reply_markup: draftStepKeyboard(draft) },
    );
    return;
  }

  await safeReply(ctx, draftReadyText(draft), { reply_markup: draftStepKeyboard(draft) });
}

function draftReadyText(draft) {
  const count = draft.quiz.questions.length;
  const videos = draft.quiz.questions.reduce(
    (sum, question) => sum + question.options.filter((option) => option.video_file_id).length,
    0,
  );
  const lines = [
    `Черновик «${draft.quiz.title}»: ${count} вопрос(ов), ${videos} видео.`,
    "",
  ];
  if (count < MIN_QUESTIONS) lines.push(`Нужно минимум ${MIN_QUESTIONS} вопроса — добавь ещё ${MIN_QUESTIONS - count}.`);
  if (count > RECOMMENDED_MAX) lines.push(`Больше ${RECOMMENDED_MAX} не обязательно, но можно.`);
  lines.push("", "Что дальше?");
  return lines.join("\n");
}

async function onNewTest(ctx) {
  if (ctx.chat?.type !== "private") {
    await safeReply(ctx, "Тесты собираются в личке с ботом. Напиши мне сюда в личку /newtest 🙂");
    return;
  }

  const rows = [
    [Markup.button.callback("📋 Копия основной игры", "qs:new:main")],
    [Markup.button.callback(`🎓 ${TEMPLATES.about.title}`, "qs:new:about")],
    [Markup.button.callback("🆕 С нуля", "qs:new:empty")],
  ];
  const saved = await listOwnerQuizCodes(ctx.from.id);
  if (saved.length) rows.push([Markup.button.callback(`🗂 Мои тесты (${saved.length})`, "qs:list")]);

  await safeReply(
    ctx,
    ["Соберём тест. Откуда взять вопросы?", "", `Готово: сохранишь — бот выдаст код из ${6} цифр. В группе отправишь код — тест запустится.`].join("\n"),
    { reply_markup: Markup.inlineKeyboard(rows).reply_markup },
  );
}

async function startDraft(ctx, quiz, { askTitle = false } = {}) {
  const draft = {
    step: askTitle ? "title" : "ready",
    qi: 0,
    oi: 0,
    quiz: { ...emptyQuiz(ctx.from), ...cloneQuiz(quiz) },
  };
  await saveDraft(ctx.from.id, ctx.chat.id, draft);
  await askDraftStep(ctx, draft);
}

/** Кнопки шаблона: qs:new:<template>. */
async function handleDraftCallback(ctx, data) {
  const action = data.slice(3);
  const draftKeyArgs = [ctx.from?.id, ctx.chat?.id];

  if (action === "noop") {
    await safeAnswerCb(ctx);
    return;
  }

  if (action.startsWith("del:")) {
    await deleteQuizByCode(ctx, action.slice(4));
    return;
  }

  if (action === "list") {
    await safeAnswerCb(ctx);
    await onMyList(ctx);
    return;
  }

  if (action.startsWith("new:")) {
    await safeAnswerCb(ctx);
    const key = action.slice(4);
    if (key === "empty") {
      await startDraft(ctx, emptyQuiz(ctx.from), { askTitle: true });
      return;
    }
    const quiz = quizFromTemplate(key, content);
    if (!quiz.questions.length) {
      await safeReply(ctx, "Такого шаблона нет.");
      return;
    }
    await startDraft(ctx, quiz);
    return;
  }

  const draft = await getDraft(...draftKeyArgs);
  if (!draft) {
    await safeAnswerCb(ctx, "Черновик не найден — начни заново: /newtest", { show_alert: true });
    return;
  }

  await safeAnswerCb(ctx);

  if (action === "cancel") {
    await clearDraft(...draftKeyArgs);
    await safeReply(ctx, "Отменила, черновик удалён 🗑");
    return;
  }

  if (action === "preview") {
    await sendDraftPreview(ctx, draft);
    return;
  }

  if (action === "pick") {
    await safeReply(ctx, "Какой вопрос меняем?", {
      reply_markup: Markup.inlineKeyboard(
        draft.quiz.questions.map((question, index) => [
          Markup.button.callback(`${index + 1}. ${String(question.text).slice(0, 28)}`, `qs:edit:${index}`),
        ]),
      ).reply_markup,
    });
    return;
  }

  if (action.startsWith("edit:")) {
    const index = Number(action.slice(5));
    if (!Number.isInteger(index) || !draft.quiz.questions[index]) {
      await safeReply(ctx, "Такого вопроса нет.");
      return;
    }
    draft.qi = index;
    draft.oi = 0;
    draft.step = "qtext";
    await saveDraft(ctx.from.id, ctx.chat.id, draft);
    await askDraftStep(ctx, draft);
    return;
  }

  if (action.startsWith("skip:")) {
    const step = action.slice(5);
    if (step === "opt") {
      draft.quiz.questions[draft.qi].options[draft.oi] = { label: optionLetter(draft.oi), reaction_text: "", video_file_id: null };
    }
    await applyDraftStep(ctx, draft, step, SKIP);
    return;
  }

  if (action === "more") {
    await addQuestionStep(ctx, draft);
    return;
  }

  if (action === "save") {
    await saveDraftQuiz(ctx, draft);
  }
}

async function addQuestionStep(ctx, draft) {
  if (draft.quiz.questions.length >= MAX_QUESTIONS) {
    await safeReply(ctx, `Больше ${MAX_QUESTIONS} вопросов не получится.`);
    return;
  }
  draft.qi = draft.quiz.questions.length;
  draft.oi = 0;
  draft.quiz.questions.push({ id: `t${draft.qi + 1}`, text: "", options: [] });
  draft.step = "qtext";
  await saveDraft(ctx.from.id, ctx.chat.id, draft);
  await askDraftStep(ctx, draft);
}

async function sendDraftPreview(ctx, draft) {
  const quiz = normalizeQuiz(draft.quiz).quiz;
  if (!quiz.questions.length) {
    await safeReply(ctx, "Пока пусто — добавь хотя бы один вопрос.");
    return;
  }
  const blocks = [`ЧЕРНОВИК «${quiz.title}»`, ""];
  for (const [index] of quiz.questions.entries()) {
    const question = quiz.questions[index];
    blocks.push(
      `${index + 1}. ${question.text}`,
      ...question.options.map((option, i) => `   ${optionLetter(i)}. ${option.label}${option.video_file_id ? " 🎬" : ""}`),
    );
  }
  await safeReply(ctx, "Отправляю черновик текстом…");
  for (const chunk of chunkText(blocks.join("\n"))) await send(ctx.chat.id, chunk);
  await safeReply(ctx, "Правь дальше кнопками ниже или сохраняй.", { reply_markup: draftStepKeyboard(draft) });
}

/** Продвигает мастер после полученного значения. */
async function applyDraftStep(ctx, draft, step, value) {
  const question = draftQuestionOf(draft);
  const text = String(value ?? "").trim();

  if (step === "title") {
    if (text) draft.quiz.title = text;
    draft.step = "qtext";
    if (!draft.quiz.questions.length) {
      draft.qi = 0;
      draft.quiz.questions.push({ id: "t1", text: "", options: [] });
    }
  } else if (step === "qtext") {
    if (text === SKIP && question?.text) {
      draft.step = "ready";
    } else if (text) {
      question.text = text;
      draft.oi = 0;
      draft.step = "opt";
    } else {
      await safeReply(ctx, "Нужен текст вопроса 🙂");
      return;
    }
  } else if (step === "opt") {
    if (text === SKIP && draft.oi === 0) {
      await safeReply(ctx, "Первый вариант ответа обязателен 🙂");
      return;
    }
    if (text === SKIP && draft.oi > 0) {
      question.options.length = draft.oi;
    } else if (text) {
      question.options[draft.oi] = { label: text, reaction_text: "", video_file_id: null };
    } else {
      await safeReply(ctx, "Нужен текст варианта 🙂");
      return;
    }
    draft.oi += 1;
    if (draft.oi >= 3) {
      question.options = question.options.filter(Boolean).slice(0, 3);
      draft.oi = 0;
      draft.step = question.options.length < 2 ? "opt" : "reaction";
      if (draft.step === "opt") draft.oi = question.options.length;
    }
  } else if (step === "reaction") {
    const option = question.options[draft.oi];
    if (!option) {
      await safeReply(ctx, "Сначала пришли вариант ответа 🙂");
      return;
    }
    option.reaction_text = text === SKIP ? defaultReaction(option.label) : text;
    draft.oi += 1;
    if (draft.oi >= question.options.length) {
      draft.oi = 0;
      draft.step = "video";
    }
  } else if (step === "video") {
    const option = question.options[draft.oi];
    if (!option) {
      await safeReply(ctx, "Сначала пришли вариант ответа 🙂");
      return;
    }
    option.video_file_id = text === SKIP ? null : text;
    draft.oi += 1;
    if (draft.oi >= question.options.length) {
      draft.oi = 0;
      draft.step = "ready";
    }
  }

  await saveDraft(ctx.from.id, ctx.chat.id, draft);
  await askDraftStep(ctx, draft);
}

async function onDraftInput(ctx, draft, text) {
  if (draft.step === "ready") {
    const normalized = text.toLowerCase();
    if (["ещё", "еще", "+", "добавить", "вопрос"].includes(normalized)) {
      await addQuestionStep(ctx, draft);
      return;
    }
    if (["сохранить", "сохрани", "код", "ок"].includes(normalized)) {
      await saveDraftQuiz(ctx, draft);
      return;
    }
    await safeReply(ctx, draftReadyText(draft), { reply_markup: draftStepKeyboard(draft) });
    return;
  }

  await applyDraftStep(ctx, draft, draft.step, text);
}

async function saveDraftQuiz(ctx, draft) {
  const { quiz, errors, ok } = normalizeQuiz(draft.quiz);

  if (!ok) {
    const details = errors.length ? errors.join("; ") : `нужно минимум ${MIN_QUESTIONS} вопроса, а пока ${quiz.questions.length}`;
    await safeReply(ctx, `Пока не сохраню: ${details}.`, { reply_markup: draftStepKeyboard(draft) });
    return;
  }

  const taken = await listOwnerQuizCodes(ctx.from.id);
  const allCodes = [];
  for (const code of taken) {
    const existing = await getQuiz(code);
    if (existing) allCodes.push(existing.code);
  }

  quiz.code = generateCode(allCodes);
  quiz.ownerId = ctx.from.id;
  quiz.ownerName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || quiz.ownerName;
  quiz.updatedAt = Date.now();
  await saveQuiz(quiz);
  await clearDraft(ctx.from.id, ctx.chat.id);

  await safeReply(
    ctx,
    [
      `Готово! Тест «${quiz.title}» сохранён ✅`,
      "",
      `Код: ${quiz.code}`,
      "",
      "Как запустить: открой группу с ботом и отправь этот код сообщением.",
      `Отвечать будет тот, кто отправил код, или именинник (${config.heroName}). Ответы увидят все.`,
      "",
      `Вопросов: ${quiz.questions.length}. Все тесты: /mylist`,
    ].join("\n"),
  );
}

async function onDraftSaveCommand(ctx) {
  const draft = await getDraft(ctx.from.id, ctx.chat.id);
  if (!draft) {
    await safeReply(ctx, "Черновика нет. Начни: /newtest");
    return;
  }
  await saveDraftQuiz(ctx, draft);
}

async function onDraftPreviewCommand(ctx) {
  const draft = await getDraft(ctx.from.id, ctx.chat.id);
  if (!draft) {
    await safeReply(ctx, "Черновика нет. Начни: /newtest");
    return;
  }
  await sendDraftPreview(ctx, draft);
}

async function onDraftCancelCommand(ctx) {
  await clearDraft(ctx.from.id, ctx.chat.id);
  await safeReply(ctx, "Отменила, черновик удалён 🗑");
}

async function onMyList(ctx) {
  const codes = await listOwnerQuizCodes(ctx.from.id);
  if (!codes.length) {
    await safeReply(ctx, "Тестов пока нет. Создай: /newtest");
    return;
  }

  const rows = [];
  const lines = ["Твои тесты:", ""];
  for (const code of codes) {
    const quiz = await getQuiz(code);
    if (!quiz) continue;
    const videos = quiz.questions.reduce(
      (sum, question) => sum + question.options.filter((option) => option.video_file_id).length,
      0,
    );
    lines.push(`• ${code} — «${quiz.title}», вопросов: ${quiz.questions.length}, видео: ${videos}`);
    rows.push([Markup.button.callback(`🗑 удалить ${code}`, `qs:del:${code}`)]);
  }

  await safeReply(ctx, lines.join("\n"), rows.length ? { reply_markup: Markup.inlineKeyboard(rows).reply_markup } : undefined);
}

async function deleteQuizByCode(ctx, code) {
  const quiz = await getQuiz(code);
  if (!quiz) {
    await safeAnswerCb(ctx, "Тест не найден", { show_alert: true });
    return;
  }
  if (quiz.ownerId !== ctx.from.id && !isAdmin(ctx.from.id)) {
    await safeAnswerCb(ctx, "Это не твой тест", { show_alert: true });
    return;
  }
  await deleteQuiz(code);
  await safeAnswerCb(ctx, "Удалён 🗑");
  await onMyList(ctx);
}

/* ------------------------- запуск теста по коду ------------------------- */

async function tryStartQuizByCode(ctx, code) {
  const quiz = await getQuiz(code);
  if (!quiz) return false;

  const { ok, errors, quiz: ready } = normalizeQuiz(quiz);
  if (!ok) {
    await safeReply(ctx, `Тест с кодом ${code} не запускается: ${errors.join("; ")}`);
    return true;
  }

  const chatId = ctx.chat.id;
  const existing = await getPersonalSession(chatId);
  if (existing && !existing.finished && existing.code !== ready.code) {
    await safeReply(ctx, `В этом чате уже идёт тест «${existing.title}» (код ${existing.code}). Сначала останови его: /test_stop`);
    return true;
  }

  const session = {
    chatId,
    code: ready.code,
    title: ready.title,
    ownerId: ctx.from.id,
    ownerName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Организатор",
    questionIndex: 0,
    answers: [],
    finished: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await savePersonalSession(chatId, session);

  await send(
    chatId,
    [`🧪 Запускаю тест «${ready.title}»`, `Отвечает ${session.ownerName}. Все ответы видны в чате.`].join("\n"),
  );
  await sendPersonalQuestion(chatId, session, ready);
  return true;
}

async function sendPersonalQuestion(chatId, session, quiz) {
  const question = quizQuestion(quiz, session.questionIndex);
  if (!question) {
    await sendPersonalFinal(chatId, session, quiz);
    return;
  }

  const keyboard = Markup.inlineKeyboard([
    ...question.options.map((option, i) => [Markup.button.callback(`${optionLetter(i)}`, `popt:${session.questionIndex}:${i}`)]),
    [Markup.button.callback(session.questionIndex >= quiz.questions.length - 1 ? "Финал 🎁" : "Дальше ➡️", `pnext:${session.questionIndex}`)],
  ]).reply_markup;

  await send(chatId, quizQuestionText(quiz, session.questionIndex), { reply_markup: keyboard });
}

async function answerPersonal(ctx, session, quiz, optionIndex) {
  const chatId = ctx.chat.id;
  const question = quizQuestion(quiz, session.questionIndex);
  const option = question?.options?.[optionIndex];
  if (!option) {
    await safeAnswerCb(ctx, "Такого варианта нет", { show_alert: true });
    return;
  }

  session.answers.push({
    questionIndex: session.questionIndex,
    questionId: question.id,
    optionIndex,
    optionKey: optionLetter(optionIndex),
    label: option.label,
    at: Date.now(),
  });
  await savePersonalSession(chatId, session);
  await safeAnswerCb(ctx, `Ответ принят: ${optionLetter(optionIndex)} 🎯`);

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    /* сообщение могло устареть */
  }

  await send(chatId, `Выбрано: ${optionLetter(optionIndex)}. ${option.label}`);
  await send(chatId, option.reaction_text);
  await sendVideoOrStub(chatId, option.video_file_id, fill(content.no_video_text, { name: quiz.title }), null);
}

async function nextPersonal(ctx, session, quiz, currentIndex) {
  const chatId = ctx.chat.id;
  if (session.questionIndex !== currentIndex) {
    await safeAnswerCb(ctx, "Этот вопрос уже пройден");
    return;
  }
  if (!session.answers.some((answer) => answer.questionIndex === currentIndex)) {
    await safeAnswerCb(ctx, "Сначала выбери ответ 🙂", { show_alert: true });
    return;
  }

  session.questionIndex = currentIndex + 1;
  await savePersonalSession(chatId, session);
  await safeAnswerCb(ctx, session.questionIndex >= quiz.questions.length ? "Финал! 🎉" : "Летим дальше! 🎯");

  if (session.questionIndex >= quiz.questions.length) {
    await sendPersonalFinal(chatId, session, quiz);
    return;
  }
  await sendPersonalQuestion(chatId, session, quiz);
}

async function sendPersonalFinal(chatId, session, quiz) {
  session.finished = true;
  session.finishedAt = Date.now();
  await savePersonalSession(chatId, session);

  if (quiz.finalVideoFileId) {
    await sendVideoOrStub(chatId, quiz.finalVideoFileId, "", null);
  }
  await send(chatId, quiz.finalText, {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🔁 Пройти ещё раз", "ptest:again")],
      [Markup.button.callback("🧹 Остановить тест", "ptest:stop")],
    ]).reply_markup,
  });
  await send(chatId, ["Ваши ответы:", quizSummary({ ...quiz, answers: session.answers })].join("\n"));
}

async function handlePersonalCallback(ctx, data) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;

  const session = await getPersonalSession(chatId);
  if (!session) {
    await safeAnswerCb(ctx, "Тест не запущен — отправь код сообщением 🙂", { show_alert: true });
    return;
  }

  const allowed = ctx.from.id === session.ownerId || isHero(ctx.from.id);
  if (!allowed) {
    await safeAnswerCb(ctx, `Кнопки нажимает ${session.ownerName} 🙂`, { show_alert: true });
    return;
  }

  const quiz = await getQuiz(session.code);
  if (!quiz) {
    await safeAnswerCb(ctx, "Тест удалён", { show_alert: true });
    await clearPersonalSession(chatId);
    return;
  }
  const ready = normalizeQuiz(quiz).quiz;

  if (data === "ptest:stop") {
    await safeAnswerCb(ctx, "Останавливаю");
    await clearPersonalSession(chatId);
    await send(chatId, "🧹 Тест остановлен.");
    return;
  }

  if (data === "ptest:again") {
    await safeAnswerCb(ctx, "Ещё раз! 🎉");
    const fresh = { ...session, questionIndex: 0, answers: [], finished: false, startedAt: Date.now() };
    await savePersonalSession(chatId, fresh);
    await send(chatId, `🔁 Тест «${ready.title}» начинаем заново.`);
    await sendPersonalQuestion(chatId, fresh, ready);
    return;
  }

  if (session.finished) {
    await safeAnswerCb(ctx, "Тест уже закончен 🎉", { show_alert: true });
    return;
  }

  const [, indexRaw, optionRaw] = data.split(":");
  const index = Number(indexRaw);

  if (!Number.isInteger(index) || session.questionIndex !== index) {
    await safeAnswerCb(ctx, "Этот вопрос уже пройден");
    return;
  }

  if (data.startsWith("popt:")) {
    const optionIndex = Number(optionRaw);
    if (session.answers.some((answer) => answer.questionIndex === index)) {
      await safeAnswerCb(ctx, "Ответ уже выбран 🙂", { show_alert: true });
      return;
    }
    await answerPersonal(ctx, session, ready, optionIndex);
    return;
  }

  if (data.startsWith("pnext:")) {
    await nextPersonal(ctx, session, ready, index);
  }
}

async function onTestStop(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = await getPersonalSession(chatId);
  if (!session) {
    await safeReply(ctx, "В этом чате активных тестов нет.");
    return;
  }
  if (session.ownerId !== ctx.from.id && !isHero(ctx.from.id) && !isAdmin(ctx.from.id)) {
    await safeReply(ctx, "Остановить тест может автор или именинник.");
    return;
  }

  await clearPersonalSession(chatId);
  await safeReply(ctx, `🧹 Тест «${session.title}» остановлен.`);
}

/* --------------------------- приём видео в личке --------------------------- */

async function onVideoReceived(ctx) {
  const fileId = ctx.message?.video?.file_id;
  if (!fileId) return;

  const chatType = ctx.chat?.type;
  if (chatType !== "private") {
    await safeReply(ctx, "Пришли видео мне в личку — верну готовый file_id.");
    return;
  }

  const draft = await getDraft(ctx.from?.id, ctx.chat.id);
  if (draft && draft.step === "video") {
    const question = draftQuestionOf(draft);
    const option = question?.options?.[draft.oi];
    if (option) {
      option.video_file_id = fileId;
      draft.oi += 1;
      if (draft.oi >= question.options.length) {
        draft.oi = 0;
        draft.step = "ready";
      }
      await saveDraft(ctx.from.id, ctx.chat.id, draft);
      await safeReply(ctx, `Видео на ${optionLetter(draft.oi === 0 ? question.options.length - 1 : draft.oi - 1)} подставлено 🎬`, {
        reply_markup: draftStepKeyboard(draft),
      });
      return;
    }
  }

  await safeReply(
    ctx,
    [
      "Видео принято 🎬",
      "",
      "Его file_id:",
      fileId,
      "",
      "Как привязать к варианту (в этом чате или в группе):",
      `/admin_video q1 А ${fileId}`,
      "",
      "Или вписать в content/questions.json → video_file_id и задеплоить.",
      "Финальное видео:",
      `/admin_video final video ${fileId}`,
    ].join("\n"),
  );
}

/* ------------------------- маршрутизация сообщений ------------------------- */

/*
 * Порядок: правки контента админа → черновик теста в личке → код теста в группе.
 * Всё остальное (обычный текст в группе) бот не трогает.
 */
async function onMessageRouter(ctx) {
  const text = String(ctx.message?.text ?? "");
  const chatType = ctx.chat?.type;

  if (isAdmin(ctx.from?.id) && (await getPending(ctx.from.id, ctx.chat?.id))) {
    await onAdminPendingValue(ctx);
    return;
  }

  if (chatType === "private") {
    const draft = await getDraft(ctx.from?.id, ctx.chat?.id);
    if (draft && text.trim() && !text.trim().startsWith("/")) {
      await onDraftInput(ctx, draft, text.trim());
    }
    return;
  }

  const trimmed = text.trim();
  if (CODE_RE.test(trimmed)) {
    await tryStartQuizByCode(ctx, trimmed);
  }
}
