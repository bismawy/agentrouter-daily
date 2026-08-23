import { Env, ClaimResult, StoredSession, UserSnapshot } from "./types";

const DEFAULT_BASE_URL = "https://agentrouter.org";
export const BACKUP_BASE_URL = "https://ps.air-outer.com";
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23lidtiR4LeVZvVRNL";
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

export function extractUserId(cookieStr: string): string | null {
  try {
    const sessionMatch = cookieStr.match(/session=([^;]+)/);
    if (!sessionMatch) return null;
    const sessionVal = decodeURIComponent(sessionMatch[1]);
    const firstDecode = decodeBase64Url(sessionVal);
    const parts = firstDecode.split("|");
    if (parts.length >= 2) {
      const secondDecode = decodeBase64Url(parts[1]);
      const githubMatch = secondDecode.match(/github_(\d+)/);
      if (githubMatch) return githubMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format string cookie GitHub agar siap pakai di header Cookie
 */
export function formatGithubCookie(rawCookie: string): string {
  const trimmed = rawCookie.trim();
  if (!trimmed) return "";
  if (!trimmed.includes("user_session=") && !trimmed.includes(";")) {
    return `user_session=${trimmed}; logged_in=yes`;
  }
  return trimmed;
}

/**
 * Ubah string cookie GitHub menjadi daftar cookie Playwright (domain .github.com)
 */
export function parseGithubCookies(rawCookie: string): { name: string; value: string; domain: string; path: string }[] {
  return formatGithubCookie(rawCookie)
    // Bersihkan karakter kontrol (newline/wrapping dari copy DevTools) & pecah per pasangan
    .replace(/[\r\n\t]+/g, " ")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      const name = (idx > 0 ? pair.slice(0, idx) : pair).trim();
      const value = (idx > 0 ? pair.slice(idx + 1) : "").trim();
      return { name, value, domain: ".github.com", path: "/" };
    })
    // Buang pasangan yang tidak valid (nama kosong / mengandung karakter ilegal / value mengandung spasi di tengah karena salah wrap)
    .filter((c) => c.name && !/[\s={}?&]/.test(c.name) && !/[\n\r\t]/.test(c.value));
}

/**
 * Ambil state token untuk alur OAuth CSRF dari AgentRouter
 */
async function fetchOAuthState(baseUrl: string): Promise<{ state?: string; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/oauth/state`, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
        Referer: `${baseUrl}/login`,
        Origin: baseUrl,
        "Sec-Ch-Ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}

    if (json && json.success && json.data) {
      return { state: String(json.data) };
    }
    return {
      error: `State API ${baseUrl} merespons HTTP ${res.status}: ${json?.message || text.slice(0, 120)}`,
    };
  } catch (err) {
    return {
      error: `Koneksi gagal ke ${baseUrl}/api/oauth/state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Request GitHub OAuth authorize menggunakan GitHub session cookie
 */
async function getGithubOAuthCode(
  clientId: string,
  state: string,
  githubCookie: string
): Promise<{ code?: string; state?: string; error?: string }> {
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
    clientId
  )}&state=${encodeURIComponent(state)}&scope=user:email`;

  try {
    const res = await fetch(authUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: formatGithubCookie(githubCookie),
      },
      redirect: "manual",
    });

    // 1) Kasus ideal: GitHub merespons 302 Found (langsung redirect karena sudah pernah di-authorize)
    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("location") || res.headers.get("Location") || "";
      if (location.includes("/login?") || location.startsWith("https://github.com/login")) {
        return {
          error:
            "GITHUB_COOKIE tidak valid atau sudah expired. Harap salin ulang cookie user_session dari browser.",
        };
      }

      try {
        const parsedUrl = new URL(location, "https://github.com");
        const code = parsedUrl.searchParams.get("code");
        const returnedState = parsedUrl.searchParams.get("state") || state;
        if (code) {
          return { code, state: returnedState };
        }
      } catch {}
    }

    // 2) Kasus 200 OK: GitHub menampilkan dialog persetujuan (Consent Screen)
    if (res.status === 200) {
      const html = await res.text();
      if (html.includes('id="login_field"') || html.includes('action="/session"')) {
        return {
          error: "GitHub meminta login ulang. Cookie user_session tidak valid.",
        };
      }

      // Cari authenticity_token untuk submit form persetujuan
      const tokenMatch = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
      if (tokenMatch && tokenMatch[1]) {
        const authToken = tokenMatch[1];
        const postRes = await fetch("https://github.com/login/oauth/authorize", {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: formatGithubCookie(githubCookie),
          },
          body: new URLSearchParams({
            authenticity_token: authToken,
            client_id: clientId,
            state: state,
            scope: "user:email",
            authorize: "1",
          }).toString(),
          redirect: "manual",
        });

        if (postRes.status === 302 || postRes.status === 301) {
          const loc = postRes.headers.get("location") || postRes.headers.get("Location") || "";
          const parsed = new URL(loc, "https://github.com");
          const code = parsed.searchParams.get("code");
          if (code) {
            return { code, state: parsed.searchParams.get("state") || state };
          }
        }
      }
    }

    return {
      error: `Gagal mendapatkan OAuth code dari GitHub (HTTP ${res.status}).`,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Eksekusi callback OAuth ke AgentRouter untuk memicu login ulang & reward $25
 */
async function exchangeOAuthCallback(
  baseUrl: string,
  code: string,
  state: string,
  agentRouterCookie?: string
): Promise<{ success: boolean; user?: any; newSession?: string; error?: string }> {
  try {
    const callbackUrl = `${baseUrl}/api/oauth/github?code=${encodeURIComponent(
      code
    )}&state=${encodeURIComponent(state)}`;

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: `${baseUrl}/login`,
      Origin: baseUrl,
    };
    if (agentRouterCookie) {
      headers["Cookie"] = agentRouterCookie;
    }

    const res = await fetch(callbackUrl, {
      method: "GET",
      headers,
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
    const newSession = sessionPair || undefined;

    const json = (await res.json().catch(() => null)) as any;
    if (json && json.success) {
      const user = json.data?.user || json.data || {};
      return { success: true, user, newSession };
    }

    return {
      success: false,
      error: json?.message || `OAuth callback gagal (HTTP ${res.status}).`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
        githubId: user.github_id,
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
 * Diagnosa koneksi Worker ke AgentRouter tanpa membocorkan secret.
 */
export async function diagnose(env: Env): Promise<Record<string, unknown>> {
  const baseUrl = (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const report: Record<string, unknown> = {
    baseUrl,
    hasAgentRouterCookie: Boolean(env.AGENTROUTER_COOKIE?.trim()),
    hasGithubCookie: Boolean(env.GITHUB_COOKIE?.trim()),
    hasUserId: Boolean(env.AGENTROUTER_USER_ID?.trim() || env.NEW_API_USER?.trim()),
    hasBrowserBinding: Boolean(env.BROWSER),
    hasStateBinding: Boolean(env.STATE),
  };

  // 1) Test /api/user/self (pembaca saldo)
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

  // 2) Test /api/oauth/state (pintu OAuth)
  report.state = await fetchOAuthState(baseUrl);

  return report;
}

/**
 * Baca info user & saldo terkini via HTTP biasa. Mencoba sesi tersimpan (Durable
 * Object) dulu, lalu secret AGENTROUTER_COOKIE. TIDAK menjalankan klaim/OCR —
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
 * Eksekusi auto-claim harian via Pure HTTP OAuth Re-login (fallback; dari IP
 * Worker yang ter-deploy biasanya diblokir WAF — jalur utama adalah Browser Run).
 */
export async function executeDailyClaim(
  env: Env,
  opts: { quotaBefore?: number | null; quotaBeforeFresh?: boolean } = {}
): Promise<ClaimOutcome> {
  const timestamp = new Date().toISOString();
  const githubCookie = env.GITHUB_COOKIE?.trim();
  const agentRouterCookie = env.AGENTROUTER_COOKIE?.trim();

  const candidateUrls = [
    (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    BACKUP_BASE_URL,
  ];

  // JALUR 1: Jika GITHUB_COOKIE tersedia -> Eksekusi Pure HTTP OAuth Chain
  if (githubCookie) {
    let lastError = "";

    for (const baseUrl of candidateUrls) {
      // 1. Dapatkan state token
      const stateRes = await fetchOAuthState(baseUrl);
      if (!stateRes.state) {
        lastError = stateRes.error || "Gagal mengambil state token dari AgentRouter.";
        continue;
      }
      const stateToken = stateRes.state;

      // 2. Dapatkan authorization code dari GitHub OAuth
      const oauthCodeRes = await getGithubOAuthCode(DEFAULT_GITHUB_CLIENT_ID, stateToken, githubCookie);

      if (oauthCodeRes.error || !oauthCodeRes.code) {
        lastError = oauthCodeRes.error || "Gagal mendapatkan authorization code GitHub.";
        continue;
      }

      // 3. Callback ke AgentRouter -> memicu re-login & penambahan reward $25
      const callbackRes = await exchangeOAuthCallback(
        baseUrl,
        oauthCodeRes.code,
        oauthCodeRes.state || stateToken,
        agentRouterCookie
      );

      if (!callbackRes.success) {
        lastError = callbackRes.error || "Gagal memproses callback login AgentRouter.";
        continue;
      }

      // 4. Verifikasi: baca saldo dengan sesi baru (kalau ada)
      const activeCookie = callbackRes.newSession || agentRouterCookie || "";
      const userId =
        env.AGENTROUTER_USER_ID?.trim() ||
        env.NEW_API_USER?.trim() ||
        (callbackRes.user?.id ? String(callbackRes.user.id) : extractUserId(activeCookie));

      const updatedUser = (await fetchSelf(baseUrl, activeCookie, userId)) || callbackRes.user;

      return buildClaimResult({
        user: updatedUser,
        quotaBefore: opts.quotaBefore,
        quotaBeforeFresh: opts.quotaBeforeFresh,
        via: "Pure HTTP",
        sessionCookie: callbackRes.newSession ?? null,
        baseUrl,
      });
    }

    return {
      result: {
        success: false,
        message: lastError || "Gagal melakukan Re-OAuth klaim $25 AgentRouter.",
        statusCode: 500,
        timestamp,
      },
      session: null,
    };
  }

  // JALUR 2: GITHUB_COOKIE belum disetel — hanya bisa membaca saldo sesi
  if (agentRouterCookie) {
    const userId =
      env.AGENTROUTER_USER_ID?.trim() || env.NEW_API_USER?.trim() || extractUserId(agentRouterCookie);

    for (const baseUrl of candidateUrls) {
      const user = await fetchSelf(baseUrl, agentRouterCookie, userId);
      if (user) {
        const balanceUsd = balanceFromQuota(user.quota ?? 0);
        return {
          result: {
            success: false,
            message:
              "GITHUB_COOKIE belum disetel di Secrets. AgentRouter mewajibkan re-login GitHub harian untuk klaim $25. Saldo saat ini terbaca normal.",
            statusCode: 200,
            balance: balanceUsd,
            details: { ...mapUserToSnapshot(user), last_login_time: user.last_login_time },
            timestamp,
          },
          session: null,
        };
      }
    }
  }

  return {
    result: {
      success: false,
      message: "Konfigurasi tidak lengkap: Harap tambahkan GITHUB_COOKIE di Environment Secrets.",
      statusCode: 400,
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
  assert(formatGithubCookie("abc").includes("user_session=abc"), "formatGithubCookie simple token");
  assert(formatGithubCookie("user_session=xyz; logged_in=yes") === "user_session=xyz; logged_in=yes", "formatGithubCookie full string");

  const ghCookies = parseGithubCookies("user_session=abc; logged_in=yes");
  assert(ghCookies.length === 2, "parseGithubCookies -> 2 cookies");
  assert(ghCookies[0].name === "user_session" && ghCookies[0].value === "abc", "parseGithubCookies user_session");
  assert(ghCookies[0].domain === ".github.com", "parseGithubCookies domain");
  const ghSingle = parseGithubCookies("gho_xyz");
  assert(ghSingle.length === 2 && ghSingle[0].name === "user_session" && ghSingle[0].value === "gho_xyz", "parseGithubCookies single token");

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
