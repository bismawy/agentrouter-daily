import { Env, ClaimResult } from "./types";

export async function notify(env: Env, result: ClaimResult): Promise<void> {
  const statusEmoji = result.success ? "✅" : "❌";
  const title = `${statusEmoji} <b>AgentRouter Daily Auto-Claim</b>`;
  const time = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

  const telegramMsg = [
    title,
    `📅 <b>Waktu:</b> ${time} WIB`,
    `📊 <b>Status:</b> ${result.success ? "Berhasil" : "Gagal"}`,
    `💬 <b>Pesan:</b> ${result.message}`,
    result.balance ? `💰 <b>Saldo:</b> ${result.balance}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const discordMsg = [
    `**${statusEmoji} AgentRouter Daily Auto-Claim**`,
    `> **Waktu:** ${time} WIB`,
    `> **Status:** ${result.success ? "Berhasil" : "Gagal"}`,
    `> **Pesan:** ${result.message}`,
    result.balance ? `> **Saldo:** ${result.balance}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const tasks: Promise<unknown>[] = [];

  // Telegram Notification
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: telegramMsg,
          parse_mode: "HTML",
        }),
      }).catch((err) => console.error("Telegram notify failed:", err))
    );
  }

  // Discord Notification
  if (env.DISCORD_WEBHOOK_URL) {
    tasks.push(
      fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: discordMsg }),
      }).catch((err) => console.error("Discord notify failed:", err))
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}
