import { handleUpdate, botInfo } from "../src/bot.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  if (req.rawBody !== undefined && req.rawBody !== null) {
    return Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : String(req.rawBody);
  }
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);

  const readable = typeof req?.on === "function" && typeof req[Symbol.asyncIterator] === "function";
  if (!readable) return "";

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    console.error("[telegram] не смог прочитать тело запроса:", error?.message || error);
    return "";
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "prazdnichnaya-svoya-igra", bot: botInfo() });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  let updateId = null;
  try {
    const raw = await readRawBody(req);
    if (!raw) return res.status(200).send("ok");
    const update = JSON.parse(raw);
    updateId = update?.update_id ?? null;
    await handleUpdate(update);
  } catch (error) {
    console.error(`[telegram] update ${updateId} failed:`, error?.stack || error);
  }

  return res.status(200).send("ok");
}
