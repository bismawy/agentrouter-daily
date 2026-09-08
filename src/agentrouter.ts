import { Env, ClaimResult, StoredSession, UserSnapshot } from "./types";

const DEFAULT_BASE_URL = "https://agentrouter.org";
export const BACKUP_BASE_URL = "https://ps.air-outer.com";
const QUOTA_PER_UNIT = 500000; // New-API: 500,000 unit = $1.00 USD
export const REWARD_UNITS = 12500000; // reward harian $25 = 12.5 juta unit
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function balanceFromQuota(quota: number): string {
  return `$${(quota / QUOTA_PER_UNIT).toFixed(2)} USD`;
}

/** Apakah timestamp (detik/milidetik/string) menunjuk hari ini menurut WIB? */
export function isTimestampToday(raw?: number | string | null): boolean {
  if (raw == null) return false;
  const ms = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return false;
  const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
  return fmt(new Date(ms)) === fmt(new Date());
}

function decodeBase64Url(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return atob(base64);
}

/**
 * Tebak user id dari isi cookie sesi (fallback bila userId belum tersimpan).
 * Mendukung sesi login GitHub ("github_123") maupun email/password (angka polos).
 */
export function extractUserId(cookieStr: string): string | null {
  try {
    const sessionMatch = cookieStr.match(/session=([^;]+)/);
    if (!sessionMatch) return null;
    const sessionVal = decodeURIComponent(sessionMatch[1]);
    const firstDecode = decodeBase64Url(sessionVal);
    const parts = firstDecode.split("|");
    if (parts.length >= 2) {
      const secondDecode = decodeBase64Url(parts[1]);
      const idMatch = secondDecode.match(/github_(\d+)/) || secondDecode.match(/(\d{3,})/);
      if (idMatch) return idMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query saldo terkini dari /api/user/self
 */
async function fetchSelf(baseUrl: string, cookie: string, userId?: string | null): Promise<any | null> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
      Referer: `${baseUrl}/console`,
      Origin: baseUrl,
      Cookie: cookie,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    if (userId) {
      headers["New-Api-User"] = userId;
    }

    const res = await fetch(`${baseUrl}/api/user/self`, { method: "GET", headers });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as any;
    if (json && json.success && json.data) {
      return json.data;
    }
    return null;
  } catch {
    return null;
  }
}

function mapUserToSnapshot(user: any): UserSnapshot {
  const quota = user.quota ?? 0;
  return {
    id: user.id,
    username: user.username ?? "",
    displayName: user.display_name || user.username || `User #${user.id}`,
    githubId: user.github_id ?? "",
    quota,
    usedQuota: user.used_quota ?? 0,
    balance: balanceFromQuota(quota),
    lastLoginTime: user.last_login_time,
  };
}

export interface ClaimOutcome {
  result: ClaimResult;
  session: StoredSession | null;
}

/**
 * Susun ClaimResult dengan verifikasi nyata: sukses = last_login_time hari ini;
 * terverifikasi = kenaikan quota >= reward $25 terukur dari baseline segar
 * (dibaca beberapa detik sebelum login, bukan dari storage yang bisa basi).
 */
export function buildClaimResult(params: {
  user: any;
  quotaBefore?: number | null;
  quotaBeforeFresh?: boolean;
  via: string;
  sessionCookie?: string | null;
  baseUrl: string;
}): ClaimOutcome {
  const user = params.user ?? {};
  const quotaNow = user.quota ?? 0;
  const loginToday = isTimestampToday(user.last_login_time);
  const delta =
    params.quotaBefore != null && Number.isFinite(params.quotaBefore) ? quotaNow - params.quotaBefore : null;
  const verified = params.quotaBeforeFresh === true && delta != null && delta >= REWARD_UNITS;
  const balanceUsd = balanceFromQuota(quotaNow);
  const displayName = user.display_name || user.username || `User #${user.id ?? "?"}`;

  let message: string;
  if (verified) {
    message = `Reward +$${(delta! / QUOTA_PER_UNIT).toFixed(2)} TERVERIFIKASI via ${params.via}! Saldo kini ${balanceUsd}. Akun: ${displayName}.`;
  } else if (loginToday) {
    message = `Login hari ini aktif via ${params.via} — saldo ${balanceUsd}, akun ${displayName}. (Kenaikan $25 tidak terukur langsung; kemungkinan reward hari ini sudah diklaim sebelumnya.)`;
  } else {
    message = `Login ${params.via} berhasil, tetapi last_login_time belum menunjuk hari ini — reward mungkin belum diberikan. Saldo ${balanceUsd}, akun ${displayName}.`;
  }

  const session: StoredSession | null = params.sessionCookie
    ? {
        cookie: params.sessionCookie,
        baseUrl: params.baseUrl,
        userId: user.id != null ? String(user.id) : null,
        savedAt: new Date().toISOString(),
      }
    : null;

  return {
    result: {
      success: loginToday,
      message,
      statusCode: 200,
      balance: balanceUsd,
      alreadyClaimed: loginToday,
      verified,
      details: {
        id: user.id,
        username: user.username,
        displayName,
        quota: quotaNow,
        usedQuota: user.used_quota,
        requestCount: user.request_count,
        lastLoginTime: user.last_login_time,
        quotaDelta: delta,
        via: params.via,
      },
      timestamp: new Date().toISOString(),
    },
    session,
  };
}

/**
 * Login email/username + password via Pure HTTP (endpoint standar new-api).
 * Sukses = Set-Cookie session + data user. Dari IP Worker yang ter-deploy
 * biasanya diblokir WAF — jalur utama tetap Browser Run.
 */
async function httpLogin(
  baseUrl: string,
  username: string,
  password: string
): Promise<{ success: boolean; user?: any; newSession?: string; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Referer: `${baseUrl}/login`,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username, password }),
    });

    // Workers: multi Set-Cookie hanya terbaca utuh via getSetCookie()
    const h = res.headers as any;
    const setCookies: string[] =
      typeof h.getSetCookie === "function"
        ? h.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")!]
          : [];
    const sessionPair = setCookies
      .map((c) => c.split(";")[0].trim())
      .find((c) => c.startsWith("session="));

    const json = (await res.json().catch(() => null)) as any;
    if (json && json.success && json.data) {
      return { success: true, user: json.data, newSession: sessionPair };
    }

    return {
      success: false,
      error: json?.message || `Login gagal (HTTP ${res.status}).`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Koneksi gagal ke ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Diagnosa koneksi Worker ke AgentRouter tanpa membocorkan secret.
 */
export async function diagnose(env: Env): Promise<Record<string, unknown>> {
  const baseUrl = (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const report: Record<string, unknown> = {
    baseUrl,
    hasAgentRouterCookie: Boolean(env.AGENTROUTER_COOKIE?.trim()),
    hasEmail: Boolean(env.AGENTROUTER_EMAIL?.trim()),
    hasPassword: Boolean(env.AGENTROUTER_PASSWORD),
    hasUserId: Boolean(env.AGENTROUTER_USER_ID?.trim() || env.NEW_API_USER?.trim()),
    hasBrowserBinding: Boolean(env.BROWSER),
    hasStateBinding: Boolean(env.STATE),
  };

  // Test /api/user/self (pembaca saldo)
  if (env.AGENTROUTER_COOKIE?.trim()) {
    const cookie = env.AGENTROUTER_COOKIE.trim();
    const userId = env.AGENTROUTER_USER_ID?.trim() || env.NEW_API_USER?.trim() || extractUserId(cookie);

    try {
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
        Referer: `${baseUrl}/console`,
        Origin: baseUrl,
        Cookie: cookie,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      };
      if (userId) headers["New-Api-User"] = userId;

      const res = await fetch(`${baseUrl}/api/user/self`, { method: "GET", headers });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}

      report.self = {
        status: res.status,
        success: json?.success ?? false,
        quota: json?.data?.quota ?? null,
        balance: json?.data?.quota != null ? balanceFromQuota(json.data.quota) : null,
        message: json?.message ?? text.slice(0, 160),
      };
    } catch (err) {
      report.self = { error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    report.self = { error: "AGENTROUTER_COOKIE tidak terpasang" };
  }

  return report;
}

/**
 * Baca info user & saldo terkini via HTTP biasa. Mencoba sesi tersimpan (Durable
 * Object) dulu, lalu secret AGENTROUTER_COOKIE. TIDAK menjalankan klaim —
 * fungsi ini murni baca supaya render dashboard tidak punya efek samping.
 * Catatan: dari Worker yang ter-deploy, request ini biasanya diblokir WAF
 * Aliyun; dashboard lalu memakai snapshot tersimpan.
 */
export async function getCurrentUserInfo(env: Env, stored?: StoredSession | null): Promise<UserSnapshot | null> {
  const seen = new Set<string>();
  const candidates: { baseUrl: string; cookie: string; userId: string | null }[] = [];

  if (stored?.cookie) {
    candidates.push({ baseUrl: stored.baseUrl, cookie: stored.cookie, userId: stored.userId });
  }
  const secretCookie = env.AGENTROUTER_COOKIE?.trim();
  if (secretCookie) {
    candidates.push({
      baseUrl: (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      cookie: secretCookie,
      userId: env.AGENTROUTER_USER_ID?.trim() || env.NEW_API_USER?.trim() || extractUserId(secretCookie),
    });
  }
  if (stored?.cookie) {
    candidates.push({ baseUrl: BACKUP_BASE_URL, cookie: stored.cookie, userId: stored.userId });
  }

  for (const c of candidates) {
    if (seen.has(c.baseUrl + c.cookie)) continue;
    seen.add(c.baseUrl + c.cookie);
    const user = await fetchSelf(c.baseUrl, c.cookie, c.userId);
    if (user) return mapUserToSnapshot(user);
  }

  return null;
}

/**
 * Eksekusi auto-claim harian via Pure HTTP login email/password (fallback; dari
 * IP Worker yang ter-deploy biasanya diblokir WAF — jalur utama adalah Browser Run).
 */
export async function executeDailyClaim(
  env: Env,
  opts: { quotaBefore?: number | null; quotaBeforeFresh?: boolean } = {}
): Promise<ClaimOutcome> {
  const timestamp = new Date().toISOString();
  const username = env.AGENTROUTER_EMAIL?.trim();
  const password = env.AGENTROUTER_PASSWORD;
  const agentRouterCookie = env.AGENTROUTER_COOKIE?.trim();

  if (!username || !password) {
    return {
      result: {
        success: false,
        message: "Konfigurasi tidak lengkap: Harap tambahkan AGENTROUTER_EMAIL & AGENTROUTER_PASSWORD di Secrets.",
        statusCode: 400,
        timestamp,
      },
      session: null,
    };
  }

  const candidateUrls = [
    (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    BACKUP_BASE_URL,
  ];

  let lastError = "";

  for (const baseUrl of candidateUrls) {
    // 1. Login email/password → Set-Cookie session + data user
    const loginRes = await httpLogin(baseUrl, username, password);
    if (!loginRes.success) {
      lastError = loginRes.error || "Login gagal.";
      continue;
    }

    // 2. Verifikasi: baca saldo dengan sesi baru (kalau ada)
    const activeCookie = loginRes.newSession || agentRouterCookie || "";
    const userId =
      env.AGENTROUTER_USER_ID?.trim() ||
      env.NEW_API_USER?.trim() ||
      (loginRes.user?.id ? String(loginRes.user.id) : extractUserId(activeCookie));

    const updatedUser = (await fetchSelf(baseUrl, activeCookie, userId)) || loginRes.user;

    return buildClaimResult({
      user: updatedUser,
      quotaBefore: opts.quotaBefore,
      quotaBeforeFresh: opts.quotaBeforeFresh,
      via: "Pure HTTP",
      sessionCookie: loginRes.newSession ?? null,
      baseUrl,
    });
  }

  return {
    result: {
      success: false,
      message: lastError || "Gagal melakukan login email/password AgentRouter.",
      statusCode: 500,
      timestamp,
    },
    session: null,
  };
}

// Self-check
if ((import.meta as any).main) {
  const assert = (cond: boolean, label: string) => {
    if (!cond) throw new Error(`FAIL: ${label}`);
    console.log(`ok: ${label}`);
  };

  assert(balanceFromQuota(500000) === "$1.00 USD", "balanceFromQuota 500000 -> $1.00");
  assert(balanceFromQuota(12500000) === "$25.00 USD", "balanceFromQuota 12500000 -> $25.00");

  const nowSec = Math.floor(Date.now() / 1000);
  assert(isTimestampToday(nowSec) === true, "isTimestampToday detik sekarang -> true");
  assert(isTimestampToday(nowSec - 3 * 86400) === false, "isTimestampToday 3 hari lalu -> false");
  assert(isTimestampToday(String(nowSec * 1000)) === true, "isTimestampToday string ms -> true");
  assert(isTimestampToday(null) === false, "isTimestampToday null -> false");

  const outcome = buildClaimResult({
    user: { id: 1, username: "u", quota: 13000000, last_login_time: nowSec },
    quotaBefore: 500000,
    quotaBeforeFresh: true,
    via: "test",
    sessionCookie: "session=abc",
    baseUrl: "https://agentrouter.org",
  });
  assert(outcome.result.success === true, "buildClaimResult login hari ini -> success");
  assert(outcome.result.verified === true, "buildClaimResult delta >= reward -> verified");
  assert(outcome.session?.cookie === "session=abc", "buildClaimResult menyimpan sesi");

  const staleOutcome = buildClaimResult({
    user: { id: 1, username: "u", quota: 13000000, last_login_time: nowSec },
    quotaBefore: 500000,
    quotaBeforeFresh: false,
    via: "test",
    baseUrl: "https://agentrouter.org",
  });
  assert(staleOutcome.result.verified !== true, "buildClaimResult baseline basi -> tidak verified");

  console.log("agentrouter self-check passed");
}
