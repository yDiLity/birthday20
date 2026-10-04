/**
 * Персональные тесты: их собирает сам пользователь в личке, бот выдаёт код,
 * в группе код запускает тест для именинника.
 *
 * Структура теста:
 * {
 *   code: "482913",
 *   title: "Про Игоря",
 *   ownerId: 111, ownerName: "Орг",
 *   questions: [{ id: "t1", text: "...", options: [{ label, reaction_text, video_file_id }] }],
 *   finalText, finalVideoFileId, createdAt, updatedAt
 * }
 */

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 20;
export const RECOMMENDED_MIN = 10;
export const RECOMMENDED_MAX = 15;
export const CODE_LENGTH = 6;

export const CODE_RE = /^\d{4,8}$/;

export function optionKey(index) {
  return ["А", "Б", "В"][index] ?? String(index + 1);
}

export function fill(template, values = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined || values[key] === null || values[key] === "" ? match : String(values[key]),
  );
}

export function defaultReaction(label) {
  return `Ответ: ${label}`;
}

export function emptyQuiz(owner) {
  return {
    code: null,
    title: "Мой тест",
    ownerId: owner?.id ?? null,
    ownerName: owner ? [owner.first_name, owner.last_name].filter(Boolean).join(" ") : "",
    questions: [],
    finalText: "",
    finalVideoFileId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function cloneQuiz(quiz) {
  return {
    ...quiz,
    questions: (quiz.questions ?? []).map((question) => ({
      ...question,
      options: (question.options ?? []).map((option) => ({ ...option })),
    })),
  };
}

function normalizeOption(option, index) {
  const label = String(option?.label ?? "").trim();
  return {
    label,
    reaction_text: String(option?.reaction_text ?? "").trim() || defaultReaction(label || optionKey(index)),
    video_file_id: option?.video_file_id ?? null,
  };
}

/** Приводит черновик к валидному тесту: проверяет вопросы и варианты. */
export function normalizeQuiz(raw) {
  const questions = [];
  const errors = [];

  for (const [index, question] of (raw.questions ?? []).entries()) {
    const text = String(question?.text ?? "").trim();
    if (!text) {
      errors.push(`вопрос ${index + 1}: пустой текст`);
      continue;
    }
    const options = (question.options ?? []).map(normalizeOption).filter((option) => option.label);
    if (options.length < 2) {
      errors.push(`вопрос ${index + 1}: нужно минимум 2 варианта с текстом`);
      continue;
    }
    questions.push({
      id: question.id ?? `t${index + 1}`,
      text,
      options: options.slice(0, 3),
    });
  }

  if (questions.length > MAX_QUESTIONS) errors.push(`больше ${MAX_QUESTIONS} вопросов`);
  if (questions.length < MIN_QUESTIONS) errors.push(`нужно минимум ${MIN_QUESTIONS} вопроса, а пока ${questions.length}`);

  return {
    quiz: {
      ...cloneQuiz(raw),
      title: String(raw.title ?? "").trim() || "Мой тест",
      questions,
      finalText: String(raw.finalText ?? "").trim() || "Тест закончен! Спасибо, что прошли 🎉",
    },
    errors,
    ok: questions.length >= MIN_QUESTIONS && errors.length === 0,
  };
}

export function quizQuestion(quiz, index) {
  return quiz?.questions?.[index] ?? null;
}

/** Код из цифр, без ведущих нулей, чтобы его было удобно продиктовать вслух. */
export function generateCode(taken = []) {
  const used = new Set(taken.map(String));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(1 + Math.floor(Math.random() * 9)) + String(Math.floor(Math.random() * 10 ** (CODE_LENGTH - 1))).padStart(CODE_LENGTH - 1, "0");
    if (!used.has(code)) return code;
  }
  for (let value = 100000; value < 999999; value += 1) {
    const code = String(value);
    if (!used.has(code)) return code;
  }
  return String(Date.now()).slice(-CODE_LENGTH);
}

export function quizQuestionText(quiz, index, name) {
  const question = quizQuestion(quiz, index);
  const total = quiz.questions.length;
  return [
    `🧪 ${quiz.title} · вопрос ${index + 1} из ${total}`,
    "",
    question.text,
    "",
    ...question.options.map((option, i) => `${optionKey(i)}. ${option.label}`),
  ].join("\n");
}

export function quizSummary(quiz) {
  return (quiz.questions ?? [])
    .map((question, index) => {
      const answer = (quiz.answers ?? []).find((item) => item.questionIndex === index);
      return `${index + 1}. ${answer ? `${answer.optionKey}. ${answer.label}` : "— без ответа"}`;
    })
    .join("\n");
}

/* --------------------------------- шаблоны -------------------------------- */

export const TEMPLATES = {
  main: {
    title: "Основная игра (копия)",
    hint: "Копия основной игры: 12 вопросов, реакции и видео уже на месте.",
    from: "main",
  },
  about: {
    title: "Про именинника",
    hint: "Заготовка на 10 вопросов: меняй тексты и варианты под себя.",
    from: "builtin",
    questions: [
      {
        text: "Что именинник выберет в меню без раздумий?",
        options: [
          { label: "Паста и пицца", reaction_text: "Вот это вкус 😋" },
          { label: "Салат и вода", reaction_text: "Режим питания включён 🥗" },
          { label: "Шашлык на всех", reaction_text: "Командный выбор 🔥" },
        ],
      },
      {
        text: "Куда он пойдёт после праздника?",
        options: [
          { label: "Сразу спать", reaction_text: "День рождения — дело святое 😴" },
          { label: "Гулять до утра", reaction_text: "Ночная смена начинается 🌃" },
          { label: "Звонить родным", reaction_text: "Обязательный пункт программы 📞" },
        ],
      },
      {
        text: "Его главная суперспособность?",
        options: [
          { label: "Всегда вовремя", reaction_text: "Часы сверяются по нему ⏰" },
          { label: "Находить потерянные вещи", reaction_text: "Вещь найдётся, если он рядом 🔎" },
          { label: "Готовить на всю компанию", reaction_text: "Кухня — его территория 🍳" },
        ],
      },
      {
        text: "Что именинник точно приносит в компанию?",
        options: [
          { label: "Смешные истории", reaction_text: "Тишины не будет 😂" },
          { label: "Хорошее настроение", reaction_text: "С этим и так всё понятно 😊" },
          { label: "Все фотографии", reaction_text: "Каждый кадр в архиве 📸" },
        ],
      },
      {
        text: "Идеальный подарок для него?",
        options: [
          { label: "Что-то вкусное", reaction_text: "Вкус решает 🍰" },
          { label: "Что-то полезное", reaction_text: "Практика — наше всё 🧰" },
          { label: "Что-то приятное", reaction_text: "Главное — от души 💛" },
        ],
      },
      {
        text: "Как проходит его идеальный выходной?",
        options: [
          { label: "Долгий сон", reaction_text: "Сон — лучший вклад в настроение 😴" },
          { label: "Дел на полный день", reaction_text: "Отдыхать он умеет 🏃" },
          { label: "Ничего не планировать", reaction_text: "Свободный день — это пустой день 🌿" },
        ],
      },
      {
        text: "Что именинник скажет про свою удачу?",
        options: [
          { label: "Она работает", reaction_text: "Проверено практикой 🍀" },
          { label: "Я не суеверенный", reaction_text: "И очень даже правильно 😄" },
          { label: "Везение — дело техники", reaction_text: "Подход инженерный 🔧" },
        ],
      },
      {
        text: "Его любимый формат компании?",
        options: [
          { label: "Большая шумная тусовка", reaction_text: "Чем громче, тем лучше 🎉" },
          { label: "Камерная компания", reaction_text: "Меньше людей — больше разговоров 🤝" },
          { label: "Дом у экрана", reaction_text: "Кино и сериалы не ждут 🎬" },
        ],
      },
      {
        text: "Что именинник точно оценит в подарке?",
        options: [
          { label: "Внимание к мелочам", reaction_text: "Мелочи решают всё 💡" },
          { label: "Смешную надпись", reaction_text: "Надпись главнее подарка 😄" },
          { label: "Личное письмо", reaction_text: "Слова значат больше вещей 💌" },
        ],
      },
      {
        text: "Пожелание, которое точно сработает?",
        options: [
          { label: "Здоровья", reaction_text: "Здоровье — самое главное ❤️" },
          { label: "Того же, что и раньше", reaction_text: "Пусть всё остаётся как есть ✨" },
          { label: "Чтобы всё получалось", reaction_text: "Пусть получается 🏅" },
        ],
      },
    ],
  },
};

export function quizFromTemplate(templateKey, content) {
  const template = TEMPLATES[templateKey];
  if (!template) return emptyQuiz(null);

  if (template.from === "main") {
    const questions = (content?.categories ?? []).flatMap((category) =>
      (category.questions ?? []).map((question) => ({
        id: question.id,
        text: question.text,
        options: question.options.map((option) => ({
          label: option.label,
          reaction_text: option.reaction_text,
          video_file_id: option.video_file_id ?? null,
        })),
      })),
    );
    return {
      code: null,
      title: "Копия основной игры",
      questions,
      finalText: content?.final_text ?? "",
      finalVideoFileId: content?.final_video_file_id ?? null,
    };
  }

  return {
    code: null,
    title: template.title,
    questions: (template.questions ?? []).map((question, index) => ({
      id: `t${index + 1}`,
      text: question.text,
      options: question.options.map((option) => ({ ...option, video_file_id: option.video_file_id ?? null })),
    })),
    finalText: "",
    finalVideoFileId: null,
  };
}

export const templateList = () =>
  Object.entries(TEMPLATES).map(([key, template]) => ({ key, title: template.title, hint: template.hint, count: template.questions?.length ?? null }));