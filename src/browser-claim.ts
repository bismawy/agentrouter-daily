import { launch } from "@cloudflare/playwright";
import { Env, StoredSession } from "./types";
import {
  parseGithubCookies,
  buildClaimResult,
  type ClaimOutcome,
  BACKUP_BASE_URL,
  DEFAULT_GITHUB_CLIENT_ID,
} from "./agentrouter";

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

/** Ubah header Cookie ("a=1; b=2") menjadi cookie Playwright untuk baseUrl. */
function parseCookieHeader(header: string, baseUrl: string): { name: string; value: string; url: string }[] {
  return header
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      return {
        name: idx > 0 ? pair.slice(0, idx) : pair,
        value: idx > 0 ? pair.slice(idx + 1) : "",
        url: baseUrl + "/",
      };
    })
    .filter((c) => c.name && c.value);
}

/**
 * Baca /api/user/self via navigasi browser (JS challenge WAF ikut tereksekusi).
 * Jika respons pertama HTML (interstitial WAF), tunggu lalu coba sekali lagi.
 */
async function readSelfJson(page: any, baseUrl: string, attempts = 2): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    const resp = await page
      .goto(`${baseUrl}/api/user/self`, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => null);
    if (!resp) return null;
    const contentType = resp.headers()["content-type"] || "";
    const text = await resp.text().catch(() => "");
    if (contentType.includes("json") || text.trimStart().startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    await page.waitForTimeout(4000).catch(() => {});
  }
  return null;
}

async function looksLikeGithubLogin(page: any): Promise<boolean> {
  return (await page.locator("#login_field").count().catch(() => 0)) > 0;
}

async function looksLikeDeviceVerification(page: any): Promise<boolean> {
  const url: string = page.url();
  if (/github\.com\/(login\/device|sessions\/verified-device|login\/two-factor)/.test(url)) return true;
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return /verify (your|the) device|device verification/i.test(text);
}

/**
 * QUICK CHECK: pakai sesi AgentRouter tersimpan untuk membaca saldo dengan satu
 * halaman browser saja (~15-30 detik). Jika last_login_time sudah hari ini,
 * reward harian sudah aktif dan OAuth penuh tidak perlu dijalankan.
 */
export async function browserCheckSession(
  env: Env,
  session: StoredSession
): Promise<{ status: "valid" | "invalid" | "error"; user?: any; message?: string }> {
  if (!env.BROWSER) return { status: "error", message: "Binding BROWSER tidak tersedia." };
  try {
    const browser = await launch(env.BROWSER);
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      await context.addCookies(parseCookieHeader(session.cookie, session.baseUrl));
      if (session.userId) {
        await context.setExtraHTTPHeaders({ "New-Api-User": session.userId });
      }
      const page = await context.newPage();
      const json = await readSelfJson(page, session.baseUrl);
      if (json && json.success && json.data) {
        return { status: "valid", user: json.data };
      }
      if (json && json.success === false) {
        return { status: "invalid", message: String(json.message || "") };
      }
      return { status: "error", message: "Self API tidak membalas JSON valid (kemungkinan halaman WAF)." };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Klaim $25 harian via Browser Run (browser sungguhan → lolos WAF Aliyun).
 * Alur: (opsional refresh github) → GitHub authorize → callback AgentRouter →
 * baca saldo → VERIFIKASI kenaikan quota → simpan sesi baru untuk besok.
 */
export async function browserClaim(
  env: Env,
  opts: { quotaBefore?: number | null; quotaBeforeFresh?: boolean } = {}
): Promise<ClaimOutcome> {
  const fail = (message: string, statusCode = 500): ClaimOutcome => ({
    result: { success: false, message, statusCode, timestamp: new Date().toISOString() },
    session: null,
  });

  const githubCookie = env.GITHUB_COOKIE?.trim();
  if (!githubCookie) {
    return fail("Browser claim: GITHUB_COOKIE belum dikonfigurasi.", 400);
  }
  if (!env.BROWSER) {
    return fail("Browser claim: binding BROWSER belum dikonfigurasi di wrangler.toml.", 400);
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
      const browser = await launch(env.BROWSER);
      try {
        const context = await browser.newContext({ userAgent: USER_AGENT });
        const failedCookies = await addGithubCookies(context, githubCookie);
        if (failedCookies.length) console.log("[BROWSER] cookie ditolak & dilewati:", failedCookies.join(", "));
        const page = await context.newPage();

        // Refresh _gh_sess: kunjungi github.com dulu agar GitHub membuat session cookie baru
        // dari user_session (persistent ~2 minggu). Menghilangkan ketergantungan pada _gh_sess
        // yang cepat expired (session cookie).
        await page.goto("https://github.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2000).catch(() => {});
        if (await looksLikeGithubLogin(page)) {
          return fail(
            "GITHUB_COOKIE tidak valid — GitHub menampilkan halaman login. Salin ulang SEMUA cookie github.com (Network Tab) lalu perbarui secret GITHUB_COOKIE.",
            401
          );
        }

        // 3. Navigasi ke GitHub authorize (browser mengikuti redirect OAuth)
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
          DEFAULT_GITHUB_CLIENT_ID
        )}&state=${encodeURIComponent(state)}&scope=user:email`;
        await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        console.log("[BROWSER] github url:", page.url());

        // Fail-fast: sesi GitHub mati / diminta login ulang / verifikasi perangkat
        if (/github\.com\/(login|session)/.test(page.url()) || (await looksLikeGithubLogin(page))) {
          return fail(
            "GITHUB_COOKIE tidak valid/expired (dialihkan ke halaman login GitHub). Salin ulang cookie lalu perbarui secret.",
            401
          );
        }
        if (await looksLikeDeviceVerification(page)) {
          return fail(
            "GitHub meminta VERIFIKASI PERANGKAT (device verification) — sesi dianggap mencurigakan. Login github.com di browser biasa, selesaikan verifikasi, lalu salin ulang cookie.",
            401
          );
        }

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
        const selfJson = await readSelfJson(page, baseUrl);
        if (!(selfJson && selfJson.success && selfJson.data)) {
          lastError = `Self API ${baseUrl} gagal: ${selfJson?.message || "respons tidak valid"}.`;
          continue;
        }

        // 7. Tangkap sesi AgentRouter hasil login untuk dipakai besok (quick check)
        const cookies = await context.cookies(new URL(baseUrl).origin).catch(() => []);
        const sessionCookie = cookies.find((c: any) => c.name === "session");

        // 8. Susun hasil + verifikasi kenaikan saldo terhadap baseline
        return buildClaimResult({
          user: selfJson.data,
          quotaBefore: opts.quotaBefore,
          quotaBeforeFresh: opts.quotaBeforeFresh,
          via: "Browser Run",
          sessionCookie: sessionCookie ? `session=${sessionCookie.value}` : null,
          baseUrl,
        });
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|rate limit|limit exceeded/i.test(msg)) {
        return fail(
          `Kuota Browser Run habis (free tier 10 menit/hari, reset 00:00 UTC): ${msg}`,
          429
        );
      }
      lastError = msg;
    }
  }

  return fail(lastError || "Browser claim gagal tanpa pesan error.");
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

    // Refresh _gh_sess: kunjungi github.com dulu agar GitHub membuat session cookie baru
    await page.goto("https://github.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    report.githubHomeUrl = page.url();
    report.loggedInAfterGithubVisit = !(await looksLikeGithubLogin(page));
    await page.waitForTimeout(2000).catch(() => {});

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
      DEFAULT_GITHUB_CLIENT_ID
    )}&state=${encodeURIComponent(state)}&scope=user:email`;
    const t0 = Date.now();
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    report.githubUrl = page.url();
    report.githubElapsedMs = Date.now() - t0;
    report.githubCookies = (await context.cookies("https://github.com")).map((c) => c.name);
    report.hasLoginField = await looksLikeGithubLogin(page);
    report.hasDeviceVerification = await looksLikeDeviceVerification(page);
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

    const selfJson = await readSelfJson(page, baseUrl);
    report.selfSuccess = selfJson?.success ?? null;
    report.selfBody = JSON.stringify(selfJson).slice(0, 300);
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    await browser.close().catch(() => {});
  }

  return report;
}
