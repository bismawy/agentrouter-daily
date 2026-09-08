export interface Env {
  AGENTROUTER_COOKIE?: string;
  /** Kredensial login Email/Username + Password AgentRouter (Cloudflare Secret). */
  AGENTROUTER_EMAIL?: string;
  AGENTROUTER_PASSWORD?: string;
  AGENTROUTER_USER_ID?: string;
  NEW_API_USER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DISCORD_WEBHOOK_URL?: string;
  TRIGGER_AUTH_KEY?: string;
  AGENTROUTER_BASE_URL?: string;
  // Browser Run binding (dari wrangler.toml [browser]); undefined jika tidak dikonfigurasi
  BROWSER?: any;
  // Durable Object binding (dari wrangler.toml [durable_objects]) — sesi, riwayat & lock
  STATE?: any;
}

/**
 * Sesi AgentRouter hasil login (disimpan di Durable Object agar hari berikutnya
 * tidak wajib menari OAuth penuh via GitHub).
 */
export interface StoredSession {
  cookie: string; // header Cookie utuh, mis. "session=..."
  baseUrl: string; // host asal cookie (agentrouter.org / ps.air-outer.com)
  userId: string | null;
  savedAt: string; // ISO
}

/** Snapshot info user terakhir yang diketahui (untuk dashboard tanpa request live). */
export interface UserSnapshot {
  id: number;
  username: string;
  displayName: string;
  githubId: string;
  quota: number;
  usedQuota: number;
  balance: string;
  lastLoginTime?: number;
}

export interface ClaimResult {
  success: boolean;
  message: string;
  statusCode?: number;
  balance?: string;
  /** Login hari ini sudah aktif (reward harian sudah diberikan AgentRouter). */
  alreadyClaimed?: boolean;
  /** True hanya bila kenaikan saldo >= $25 terukur langsung (quota sebelum vs sesudah). */
  verified?: boolean;
  /** True bila eksekusi dilewati (lock aktif / sudah diklaim) — tidak dicatat ke riwayat. */
  skipped?: boolean;
  details?: Record<string, unknown>;
  timestamp: string;
}
