import { Env, ClaimResult } from "./types";

const DEFAULT_BASE_URL = "https://agentrouter.org";
export const BACKUP_BASE_URL = "https://ps.air-outer.com";
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23lidtiR4LeVZvVRNL";
const CHECKIN_PATH = "/api/user/checkin";
const QUOTA_PER_UNIT = 500000; // New-API: 500,000 unit = $1.00 USD
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function balanceFromQuota(quota: number): string {
  return `$${(quota / QUOTA_PER_UNIT).toFixed(2)} USD`;
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

    const setCookie = res.headers.get("set-cookie") || "";
    const sessionMatch = setCookie.match(/session=([^;]+)/);
    const newSession = sessionMatch ? `session=${sessionMatch[1]}` : undefined;

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

/**
 * Diagnosa koneksi Worker ke AgentRouter tanpa membocorkan secret.
 * Dipakai untuk memastikan apakah secret terpasang dan apakah WAF memblokir IP Worker.
 */
export async function diagnose(env: Env): Promise<Record<string, unknown>> {
  const baseUrl = (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const report: Record<string, unknown> = {
    baseUrl,
    hasAgentRouterCookie: Boolean(env.AGENTROUTER_COOKIE?.trim()),
    hasGithubCookie: Boolean(env.GITHUB_COOKIE?.trim()),
    hasUserId: Boolean(env.AGENTROUTER_USER_ID?.trim() || env.NEW_API_USER?.trim()),
    hasBrowserBinding: Boolean(env.BROWSER),
  };

  // 1) Test /api/user/self (pembaca saldo)
  if (env.AGENTROUTER_COOKIE?.trim()) {
    const cookie = env.AGENTROUTER_COOKIE.trim();
    const userId =
      env.AGENTROUTER_USER_ID?.trim() ||
      env.NEW_API_USER?.trim() ||
      extractUserId(cookie);

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
 * Ambil informasi pengguna dan saldo aktual secara langsung (tanpa klaim)
 */
export async function getCurrentUserInfo(env: Env): Promise<{
  id: number;
  username: string;
  displayName: string;
  githubId: string;
  quota: number;
  usedQuota: number;
  balance: string;
  lastLoginTime?: number;
} | null> {
  const cookie = env.AGENTROUTER_COOKIE?.trim();

  const userId =
    env.AGENTROUTER_USER_ID?.trim() ||
    env.NEW_API_USER?.trim() ||
    (cookie ? extractUserId(cookie) : null);

  const candidateUrls = [
    (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    BACKUP_BASE_URL,
  ];

  if (cookie) {
    for (const baseUrl of candidateUrls) {
      const user = await fetchSelf(baseUrl, cookie, userId);
      if (user) {
        return {
          id: user.id,
          username: user.username,
          displayName: user.display_name || user.username || `User #${user.id}`,
          githubId: user.github_id || user.username || "",
          quota: user.quota ?? 0,
          usedQuota: user.used_quota ?? 0,
          balance: balanceFromQuota(user.quota ?? 0),
          lastLoginTime: user.last_login_time,
        };
      }
    }
  }

  // Fallback: Jika AGENTROUTER_COOKIE tidak ada/expired tapi GITHUB_COOKIE ada, jalankan OAuth
  if (env.GITHUB_COOKIE?.trim()) {
    const claimRes = await executeDailyClaim(env);
    if (claimRes.success && claimRes.details) {
      const user = claimRes.details as any;
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username || `User #${user.id}`,
        githubId: user.githubId || user.username || "",
        quota: user.quota ?? 0,
        usedQuota: user.usedQuota ?? 0,
        balance: claimRes.balance || balanceFromQuota(user.quota ?? 0),
        lastLoginTime: user.lastLoginTime || user.last_login_time,
      };
    }
  }

  return null;
}

/**
 * Eksekusi auto-claim harian via Pure HTTP OAuth Re-login
 */
export async function executeDailyClaim(env: Env): Promise<ClaimResult> {
  const timestamp = new Date().toISOString();
  const githubCookie = env.GITHUB_COOKIE?.trim();
  const agentRouterCookie = env.AGENTROUTER_COOKIE?.trim();

  const candidateUrls = [
    (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    BACKUP_BASE_URL,
  ];

  // JALUR 1: Jika GITHUB_COOKIE tersedia -> Eksekusi Pure HTTP OAuth Chain (Klaim $25 Riil)
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
      const oauthCodeRes = await getGithubOAuthCode(
        DEFAULT_GITHUB_CLIENT_ID,
        stateToken,
        githubCookie
      );

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

      // 4. Verifikasi saldo terbaru
      const activeCookie = callbackRes.newSession || agentRouterCookie || "";
      const userId =
        env.AGENTROUTER_USER_ID?.trim() ||
        env.NEW_API_USER?.trim() ||
        (callbackRes.user?.id ? String(callbackRes.user.id) : extractUserId(activeCookie));

      const updatedUser = (await fetchSelf(baseUrl, activeCookie, userId)) || callbackRes.user;
      const displayName = updatedUser?.display_name || updatedUser?.username || "User";
      const balanceUsd = balanceFromQuota(updatedUser?.quota ?? 0);

      return {
        success: true,
        message: `Re-login & Klaim $25 berhasil! Akun: ${displayName} (${updatedUser?.github_id || updatedUser?.username || ""}).`,
        statusCode: 200,
        balance: balanceUsd,
        alreadyClaimed: true,
        details: {
          id: updatedUser?.id,
          username: updatedUser?.username,
          displayName: updatedUser?.display_name,
          githubId: updatedUser?.github_id,
          quota: updatedUser?.quota,
          usedQuota: updatedUser?.used_quota,
          requestCount: updatedUser?.request_count,
          lastLoginTime: updatedUser?.last_login_time,
        },
        timestamp,
      };
    }

    return {
      success: false,
      message: lastError || "Gagal melakukan Re-OAuth klaim $25 AgentRouter.",
      statusCode: 500,
      timestamp,
    };
  }

  // JALUR 2: Fallback jika GITHUB_COOKIE belum disetel (Hanya membaca saldo sesi)
  if (agentRouterCookie) {
    const userId =
      env.AGENTROUTER_USER_ID?.trim() ||
      env.NEW_API_USER?.trim() ||
      extractUserId(agentRouterCookie);

    for (const baseUrl of candidateUrls) {
      const user = await fetchSelf(baseUrl, agentRouterCookie, userId);
      if (user) {
        const balanceUsd = balanceFromQuota(user.quota ?? 0);
        return {
          success: false,
          message:
            "GITHUB_COOKIE belum disetel di Secrets. AgentRouter mewajibkan re-login GitHub harian untuk klaim $25. Saldo saat ini terbaca normal.",
          statusCode: 200,
          balance: balanceUsd,
          details: user,
          timestamp,
        };
      }
    }
  }

  return {
    success: false,
    message: "Konfigurasi tidak lengkap: Harap tambahkan GITHUB_COOKIE di Environment Secrets.",
    statusCode: 400,
    timestamp,
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

  console.log("agentrouter self-check passed");
}
