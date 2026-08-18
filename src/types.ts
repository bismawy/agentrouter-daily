export interface Env {
  AGENTROUTER_COOKIE: string;
  AGENTROUTER_USER_ID?: string;
  NEW_API_USER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DISCORD_WEBHOOK_URL?: string;
  TRIGGER_AUTH_KEY?: string;
  AGENTROUTER_BASE_URL?: string;
}

export interface ClaimResult {
  success: boolean;
  message: string;
  statusCode?: number;
  balance?: string;
  alreadyClaimed?: boolean;
  details?: Record<string, unknown>;
  timestamp: string;
}
