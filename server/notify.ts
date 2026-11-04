import axios from "axios";
import { log } from "./index";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_TIMEOUT = 10000;

/**
 * Send a Telegram message. Does nothing unless TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID are set, and never throws: an alert failing must not affect
 * the download it's about. Only the error's message is logged, because the
 * request URL contains the bot token.
 */
export async function notify(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text },
      { timeout: TELEGRAM_TIMEOUT },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Telegram alert failed: ${message}`, "daemon");
  }
}
