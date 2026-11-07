export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  APP_PUBLIC_URL?: string;
}
