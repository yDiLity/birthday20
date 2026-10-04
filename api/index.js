export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    service: "prazdnichnaya-svoya-igra",
    status: "Ждём апдейты от Telegram",
  });
}
