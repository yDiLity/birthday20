import fs from "node:fs";
import path from "node:path";

const ACTION = process.argv[2] || "info";

function loadEnvFile() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
    console.log(`[env] прочитан ${name}`);
  }
}

loadEnvFile();

const token = String(process.env.BOT_TOKEN ?? "").trim();
const webhookUrl = String(process.env.WEBHOOK_URL ?? "").trim();

if (!token) {
  console.error("BOT_TOKEN не найден. Задай переменную окружения или заполни .env.local (см. .env.example).");
  process.exit(1);
}

if ((ACTION === "set" || ACTION === "info") && ACTION === "set" && !webhookUrl) {
  console.error("WEBHOOK_URL не найден. Пример: https://my-bot.vercel.app/api/telegram");
  process.exit(1);
}

async function call(method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return response.json();
}

const methods = {
  async set() {
    const info = await call("setWebhook", {
      url: webhookUrl,
      drop_pending_updates: true,
      allowed_updates: ["message", "callback_query"],
    });
    console.log("setWebhook:", JSON.stringify(info));
    await methods.info();
  },
  async info() {
    const info = await call("getWebhookInfo", {});
    console.log("getWebhookInfo:", JSON.stringify(info, null, 2));
    if (info.result?.pending_update_count) {
      console.log("⚠️  Накопились апдейты, которые бот не забрал. Перезапусти set.");
    }
  },
  async delete() {
    const info = await call("deleteWebhook", { drop_pending_updates: true });
    console.log("deleteWebhook:", JSON.stringify(info));
  },
  async me() {
    const info = await call("getMe", {});
    console.log("getMe:", JSON.stringify(info, null, 2));
  },
};

const handler = methods[ACTION];
if (!handler) {
  console.error(`Неизвестная команда: ${ACTION}. Доступно: ${Object.keys(methods).join(", ")}`);
  process.exit(1);
}

await handler();
