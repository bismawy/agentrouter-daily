import { launch } from "@cloudflare/playwright";
import { Env, StoredSession } from "./types";
import {
  buildClaimResult,
  type ClaimOutcome,
  BACKUP_BASE_URL,
} from "./agentrouter";

const DEFAULT_BASE_URL = "https://agentrouter.org";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

/**
 * Login via form Email/Username + Password di halaman /login AgentRouter (new-api).
 * Melempar Error dengan pesan jelas bila kredensial salah.
 */
async function loginWithPassword(page: any, baseUrl: string, username: string, password: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });

  // Halaman login punya 2 mode: default OAuth (GitHub/LinuxDO) & mode email/password.
  const emailBtn = page.getByRole("button", { name: /sign in with email/i }).first();
  if (await emailBtn.isVisible().catch(() => false)) {
    await emailBtn.click();
  }

  const userInput = page.locator('input[name="username"]');
  const passInput = page.locator('input[name="password"]');
  await userInput.waitFor({ timeout: 15000 });
  await userInput.fill(username);
  await passInput.fill(password);

  await page.getByRole("button", { name: /^continue$/i }).first().click();

  // Sukses = keluar dari /login (redirect ke console). Salah kredensial = tetap di /login.
  await page
    .waitForURL((url: URL) => !url.pathname.startsWith("/login"), { timeout: 30000 })
    .catch(() => {});

  if (page.url().startsWith(`${baseUrl}/login`)) {
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const m = bodyText.match(/(wrong|invalid|incorrect)[^\n]{0,80}/i);
    throw new Error(
      m
        ? `Login ditolak AgentRouter: "${m[0].trim()}". Periksa AGENTROUTER_EMAIL & AGENTROUTER_PASSWORD.`
        : "Login tetap di halaman /login — kredensial kemungkinan salah atau muncul captcha."
    );
  }
}

/**
 * QUICK CHECK: pakai sesi AgentRouter tersimpan untuk membaca saldo dengan satu
 * halaman browser saja (~15-30 detik). Jika last_login_time sudah hari ini,
 * reward harian sudah aktif dan login penuh tidak perlu dijalankan.
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
 * Alur: login form Email/Password di /login → baca saldo → VERIFIKASI kenaikan
 * quota → simpan sesi baru untuk besok.
 */
export async function browserClaim(
  env: Env,
  opts: { quotaBefore?: number | null; quotaBeforeFresh?: boolean } = {}
): Promise<ClaimOutcome> {
  const fail = (message: string, statusCode = 500): ClaimOutcome => ({
    result: { success: false, message, statusCode, timestamp: new Date().toISOString() },
    session: null,
  });

  const username = env.AGENTROUTER_EMAIL?.trim();
  const password = env.AGENTROUTER_PASSWORD;
  if (!username || !password) {
    return fail("Browser claim: AGENTROUTER_EMAIL / AGENTROUTER_PASSWORD belum dikonfigurasi.", 400);
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
      const browser = await launch(env.BROWSER);
      try {
        const context = await browser.newContext({ userAgent: USER_AGENT });
        const page = await context.newPage();

        // 1. Login via form email/password (WAF lolos karena browser sungguhan)
        await loginWithPassword(page, baseUrl, username, password);
        console.log("[BROWSER] login url:", page.url());

        // 2. Baca saldo via browser (WAF lolos karena JS challenge dijalankan)
        const selfJson = await readSelfJson(page, baseUrl);
        if (!(selfJson && selfJson.success && selfJson.data)) {
          lastError = `Self API ${baseUrl} gagal: ${selfJson?.message || "respons tidak valid"}.`;
          continue;
        }

        // 3. Tangkap sesi AgentRouter hasil login untuk dipakai besok (quick check)
        const cookies = await context.cookies(new URL(baseUrl).origin).catch(() => []);
        const sessionCookie = cookies.find((c: any) => c.name === "session");

        // 4. Susun hasil + verifikasi kenaikan saldo terhadap baseline
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
      // Salah kredensial tidak perlu dicoba di base URL lain — gagal cepat.
      if (/login ditolak|kredensial/i.test(msg)) {
        return fail(msg, 401);
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
    hasEmail: Boolean(env.AGENTROUTER_EMAIL?.trim()),
    hasPassword: Boolean(env.AGENTROUTER_PASSWORD),
    hasBrowserBinding: Boolean(env.BROWSER),
  };

  const username = env.AGENTROUTER_EMAIL?.trim();
  const password = env.AGENTROUTER_PASSWORD;
  if (!username || !password || !env.BROWSER) return report;

  const baseUrl = (env.AGENTROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const browser = await launch(env.BROWSER);
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    report.loginUrl = page.url();

    const emailBtn = page.getByRole("button", { name: /sign in with email/i }).first();
    report.hasEmailModeBtn = await emailBtn.isVisible().catch(() => false);
    if (report.hasEmailModeBtn) await emailBtn.click();

    const userInput = page.locator('input[name="username"]');
    report.hasUsernameField = await userInput.isVisible().catch(() => false);
    report.hasPasswordField = await page.locator('input[name="password"]').isVisible().catch(() => false);

    const t0 = Date.now();
    await loginWithPassword(page, baseUrl, username, password).catch((e) => {
      report.loginError = e instanceof Error ? e.message : String(e);
    });
    report.loginElapsedMs = Date.now() - t0;
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
