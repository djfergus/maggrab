import axios from "axios";
import type { AlertKey } from "@shared/schema";
import { log } from "./index";
import { storage } from "./storage";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_TIMEOUT = 10000;

export function isTelegramConfigured(): boolean {
  return !!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID;
}

/**
 * Send a Telegram alert if it's turned on in Settings. Does nothing unless
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, and never throws: an alert
 * failing must not affect the download it's about. Only the error's message is
 * logged, because the request URL contains the bot token.
 */
export async function notify(alert: AlertKey, text: string): Promise<void> {
  if (!isTelegramConfigured()) return;
  try {
    const { alerts } = await storage.getSettings();
    if (!alerts[alert]) return;
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
