import { launch } from "@cloudflare/playwright";
import { Env, ClaimResult } from "./types";
import { balanceFromQuota, parseGithubCookies, BACKUP_BASE_URL, DEFAULT_GITHUB_CLIENT_ID } from "./agentrouter";

const DEFAULT_BASE_URL = "https://agentrouter.org";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Ambil state token OAuth dari AgentRouter (HTTP biasa — endpoint ini lolos WAF dari Worker)
 */
async function fetchOAuthState(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/oauth/state`, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: `${baseUrl}/login`,
        Origin: baseUrl,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const json = (await res.json().catch(() => null)) as any;
    if (json && json.success && json.data) return String(json.data);
    return null;
  } catch {
    return null;
  }
}

/**
 * Inject cookie GitHub ke browser context dengan toleransi: coba semua sekaligus,
 * jika ditolak coba satu-per-satu dan lewati yang invalid (kembalikan nama-namanya).
 * Nilai cookie tidak pernah dibocorkan.
 */
async function addGithubCookies(context: any, githubCookie: string): Promise<string[]> {
  const cookies = parseGithubCookies(githubCookie);
  const failed: string[] = [];
  try {
    await context.addCookies(cookies);
  } catch {
    for (const c of cookies) {
      try {
        await context.addCookies([c]);
      } catch {
        failed.push(c.name);
      }
    }
  }
  return failed;
}

/**
 * Klaim $25 harian via Browser Run (browser sungguhan → lolos WAF Aliyun).
 * Alur: state → GitHub authorize (dengan sesi GitHub) → callback AgentRouter → baca saldo.
 */
export async function browserClaim(env: Env): Promise<ClaimResult> {
  const timestamp = new Date().toISOString();
  const githubCookie = env.GITHUB_COOKIE?.trim();
  const browserBinding = env.BROWSER;

  if (!githubCookie) {
    return {
      success: false,
      message: "Browser claim: GITHUB_COOKIE belum dikonfigurasi.",
      statusCode: 400,
      timestamp,
    };
  }
  if (!browserBinding) {
    return {
      success: false,
      message: "Browser claim: binding BROWSER belum dikonfigurasi di wrangler.toml.",
      statusCode: 400,
      timestamp,
    };
  }

  const candidateUrls = [
    (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    BACKUP_BASE_URL,
  ];

  let lastError = "";

  for (const baseUrl of candidateUrls) {
    try {
      // 1. State token (HTTP biasa)
      const state = await fetchOAuthState(baseUrl);
      if (!state) {
        lastError = `Gagal mengambil state token dari ${baseUrl}.`;
        continue;
      }

      // 2. Launch browser + inject sesi GitHub
      const browser = await launch(browserBinding);
      try {
        const context = await browser.newContext({ userAgent: USER_AGENT });
        const failedCookies = await addGithubCookies(context, githubCookie);
        if (failedCookies.length) console.log("[BROWSER] cookie ditolak & dilewati:", failedCookies.join(", "));
        const page = await context.newPage();

        // 3. Navigasi ke GitHub authorize (browser mengikuti redirect OAuth)
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
          DEFAULT_GITHUB_CLIENT_ID
        )}&state=${encodeURIComponent(state)}&scope=user:email`;
        await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        console.log("[BROWSER] github url:", page.url());

        // 4. Jika GitHub menampilkan consent screen (belum pernah authorize), klik tombol Authorize
        if (page.url().startsWith("https://github.com")) {
          const authorizeBtn = page.getByRole("button", { name: /authorize/i }).first();
          const hasBtn = await authorizeBtn.isVisible().catch(() => false);
          console.log("[BROWSER] authorize button visible:", hasBtn);
          if (hasBtn) {
            await authorizeBtn.click();
          }
        }

        // 5. Tunggu redirect balik ke AgentRouter (callback OAuth selesai)
        await page.waitForURL(/(agentrouter\.org|air-outer\.com)/, { timeout: 45000 });
        console.log("[BROWSER] callback url:", page.url());

        // 6. Baca saldo via browser (WAF lolos karena JS challenge dijalankan)
        const selfResp = await page.goto(`${baseUrl}/api/user/self`, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        if (!selfResp) {
          lastError = `Self API ${baseUrl}: tidak ada respons.`;
          continue;
        }
        const selfJson = (await selfResp.json().catch(() => null)) as any;

        if (selfJson && selfJson.success && selfJson.data) {
          const user = selfJson.data;
          const balanceUsd = balanceFromQuota(user.quota ?? 0);
          return {
            success: true,
            message: `Re-login & Klaim $25 berhasil (Browser Run)! Akun: ${user.display_name || user.username || `User #${user.id}`}.`,
            statusCode: 200,
            balance: balanceUsd,
            alreadyClaimed: true,
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
        }

        lastError = `Self API ${baseUrl} gagal: ${selfJson?.message || "respons tidak valid"}.`;
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    success: false,
    message: lastError || "Browser claim gagal tanpa pesan error.",
    statusCode: 500,
    timestamp,
  };
}

/**
 * Diagnosa alur browser step-by-step (tanpa membocorkan secret) untuk menemukan titik gagal.
 */
export async function diagnoseBrowser(env: Env): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    hasGithubCookie: Boolean(env.GITHUB_COOKIE?.trim()),
    hasBrowserBinding: Boolean(env.BROWSER),
  };

  if (!env.GITHUB_COOKIE?.trim() || !env.BROWSER) return report;

  const baseUrl = (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const state = await fetchOAuthState(baseUrl);
  report.state = state;
  if (!state) return report;

  const browser = await launch(env.BROWSER);
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const invalidCookies = await addGithubCookies(context, env.GITHUB_COOKIE);
    report.invalidCookies = invalidCookies;
    const page = await context.newPage();

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
      DEFAULT_GITHUB_CLIENT_ID
    )}&state=${encodeURIComponent(state)}&scope=user:email`;
    const t0 = Date.now();
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    report.githubUrl = page.url();
    report.githubElapsedMs = Date.now() - t0;
    report.githubCookies = (await context.cookies("https://github.com")).map((c) => c.name);
    report.hasLoginField =
      (await page.locator("#login_field").count().catch(() => 0)) > 0;
    const authBtn = page.getByRole("button", { name: /authorize/i }).first();
    report.hasAuthorizeBtn = await authBtn.isVisible().catch(() => false);

    if (report.hasAuthorizeBtn) {
      await authBtn.click();
      // Tunggu navigasi/redirect sebentar, lalu tangkap kondisi halaman
      await page.waitForTimeout(5000).catch(() => {});
      report.afterClickUrl = page.url();
      report.afterClickTitle = await page.title().catch(() => "");
      report.afterClickText = (await page.locator("body").innerText().catch(() => "")).slice(0, 600);
    }

    try {
      await page.waitForURL(/(agentrouter\.org|air-outer\.com)/, { timeout: 30000 });
    } catch (e) {
      report.waitForUrlError = e instanceof Error ? e.message : String(e);
    }
    report.finalUrl = page.url();

    const selfResp = await page.goto(`${baseUrl}/api/user/self`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    report.selfStatus = selfResp ? selfResp.status() : null;
    const text = selfResp ? await selfResp.text().catch(() => "") : "";
    report.selfBody = text.slice(0, 300);
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    await browser.close().catch(() => {});
  }

  return report;
}
