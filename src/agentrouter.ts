import { Env, ClaimResult } from "./types";

const DEFAULT_BASE_URL = "https://agentrouter.org";
const BACKUP_BASE_URL = "https://ps.air-outer.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * URL-safe base64 decoder
 */
function decodeBase64Url(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return atob(base64);
}

/**
 * Ekstrak user ID (New-Api-User) dari binary session cookie Go/Gorilla jika tersedia
 */
function extractUserId(cookieStr: string): string | null {
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

export async function executeDailyClaim(env: Env): Promise<ClaimResult> {
  const cookie = env.AGENTROUTER_COOKIE?.trim();
  const timestamp = new Date().toISOString();

  if (!cookie) {
    return {
      success: false,
      message: "AGENTROUTER_COOKIE belum dikonfigurasi di Environment Secrets.",
      timestamp,
    };
  }

  const userId =
    env.AGENTROUTER_USER_ID?.trim() ||
    env.NEW_API_USER?.trim() ||
    extractUserId(cookie);

  const candidateUrls = [
    (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    BACKUP_BASE_URL,
  ];

  let lastStatus = 0;
  let lastErrorMessage = "";

  for (const baseUrl of candidateUrls) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
      Referer: `${baseUrl}/console`,
      Origin: baseUrl,
      Cookie: cookie,
      "Sec-Ch-Ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };

    if (userId) {
      headers["New-Api-User"] = userId;
    }

    try {
      const selfRes = await fetch(`${baseUrl}/api/user/self`, {
        method: "GET",
        headers,
      });

      lastStatus = selfRes.status;
      const contentType = selfRes.headers.get("content-type") || "";

      if (contentType.includes("json")) {
        const json = (await selfRes.json().catch(() => null)) as any;
        if (json && json.success && json.data) {
          const user = json.data;
          const displayName = user.display_name || user.username || `User #${user.id}`;
          // Quota di New-API: 500,000 unit = $1.00 USD
          const quotaPerUnit = 500000;
          const currentQuota = user.quota ?? 0;
          const balanceUsd = (currentQuota / quotaPerUnit).toFixed(2);

          return {
            success: true,
            message: `Check-in harian berhasil! Akun: ${displayName} (${user.github_id || user.username}).`,
            statusCode: 200,
            balance: `$${balanceUsd} USD`,
            details: {
              id: user.id,
              username: user.username,
              displayName: user.display_name,
              githubId: user.github_id,
              quota: user.quota,
              usedQuota: user.used_quota,
              requestCount: user.request_count,
              lastLoginTime: user.last_login_time,
            },
            timestamp,
          };
        } else if (json && json.message) {
          lastErrorMessage = json.message;
        }
      } else {
        lastErrorMessage = `HTML Response / WAF Challenge (Status ${selfRes.status})`;
      }

      if (selfRes.status === 401) {
        lastErrorMessage = lastErrorMessage || "Session cookie sudah expired atau New-Api-User tidak cocok.";
      }
    } catch (err) {
      lastErrorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    success: false,
    message: lastErrorMessage || "Gagal klaim check-in harian AgentRouter.",
    statusCode: lastStatus || 500,
    timestamp,
  };
}
