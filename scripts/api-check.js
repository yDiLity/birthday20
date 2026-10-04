import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRequire } from "node:module";

process.env.BOT_TOKEN = process.env.BOT_TOKEN || "TEST-TOKEN";
process.env.ADMIN_ID = "1";
process.env.HERO_NAME = "Игорь";

const sent = [];
const nodeFetch = createRequire(`${process.cwd()}/noop.js`)("node-fetch");
nodeFetch.default = async (url, init) => {
  const method = String(url.pathname ?? url).split("/").pop();
  const payload = init?.body ? JSON.parse(init.body) : {};
  if (method === "getMe") return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 1, is_bot: true, first_name: "B", username: "b" } }) };
  if (method === "sendMessage") sent.push(String(payload.text));
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

const { setTelegramClient } = await import("../src/bot.js");
setTelegramClient({
  token: process.env.BOT_TOKEN,
  options: { apiRoot: "https://api.telegram.org" },
  async getMe() { return { id: 1, is_bot: true, first_name: "B", username: "b" }; },
  async sendMessage(chatId, text) { sent.push(String(text)); return { message_id: 1 }; },
});

const { default: handler } = await import("../api/telegram.js");

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
  return res;
}

const update = (text) => JSON.stringify({
  update_id: Math.floor(Math.random() * 1e6),
  message: {
    message_id: 1,
    from: { id: 2, is_bot: false, first_name: "Игорь" },
    chat: { id: -1001, type: "supergroup" },
    text,
    entities: [{ type: "bot_command", offset: 0, length: 6 }],
  },
});

const failures = [];
function expect(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== api/telegram.js ===");

let res = fakeRes();
await handler({ method: "GET" }, res);
expect("GET отвечает 200 и показывает статус бота", res.statusCode === 200 && res.body?.ok === true);
expect("GET показывает количество вопросов", res.body?.bot?.contentQuestions === 12);
expect("Cache-Control: no-store", res.headers["Cache-Control"] === "no-store");

res = fakeRes();
await handler({ method: "PUT" }, res);
expect("PUT отвечает 405", res.statusCode === 405);

res = fakeRes();
await handler({ method: "POST", body: "" }, res);
expect("пустое тело не роняет функцию", res.statusCode === 200);

res = fakeRes();
sent.length = 0;
await handler({ method: "POST", body: update("/start"), headers: {} }, res);
expect("тело строкой обработано", res.statusCode === 200 && sent.some((t) => t.includes("с днём рождения")), JSON.stringify(sent));

res = fakeRes();
sent.length = 0;
const bodyBuffer = Buffer.from(update("/start"), "utf8");
await handler({ method: "POST", body: bodyBuffer, rawBody: bodyBuffer }, res);
expect("тело Buffer обработано", res.statusCode === 200 && sent.length > 0);

res = fakeRes();
sent.length = 0;
await handler({ method: "POST", body: update("/start") }, res);
expect("тело объектом обработано", res.statusCode === 200 && sent.length > 0);

res = fakeRes();
sent.length = 0;
await handler({ method: "POST", body: undefined, headers: {}, on: () => {} }, res);
expect("тело нечитаемо — 200 без падения", res.statusCode === 200);

res = fakeRes();
sent.length = 0;
const payload = update("/start");
const req = Object.assign(Readable.from([Buffer.from(payload.slice(0, 30)), Buffer.from(payload.slice(30))]), {
  method: "POST",
  body: undefined,
  rawBody: undefined,
  headers: {},
});
await handler(req, res);
expect("тело пришло потоком — обработано", res.statusCode === 200 && sent.length > 0, JSON.stringify(sent));

res = fakeRes();
sent.length = 0;
await handler({ method: "POST", body: "{это не json" }, res);
expect("битый JSON не роняет функцию", res.statusCode === 200 && sent.length === 0);

res = fakeRes();
sent.length = 0;
await handler({ method: "POST", body: "null" }, res);
expect("null-апдейт игнорируется", res.statusCode === 200);

res = fakeRes();
await handler({ method: "GET" }, res);
expect("повторный GET стабилен", res.statusCode === 200);

console.log(`\n=== Итог: ${failures.length ? `❌ провалено ${failures.length}` : "✅ обработчик работает"} ===`);
if (failures.length) console.error(failures.map((f) => `  - ${f}`).join("\n"));
console.log("");
process.exit(failures.length ? 1 : 0);
