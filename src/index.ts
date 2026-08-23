import { Env, ClaimResult, StoredSession, UserSnapshot } from "./types";
import {
  executeDailyClaim,
  getCurrentUserInfo,
  diagnose,
  isTimestampToday,
  balanceFromQuota,
  type ClaimOutcome,
} from "./agentrouter";
import { browserClaim, browserCheckSession, diagnoseBrowser } from "./browser-claim";
import { notify } from "./notifier";
import { getClaimHistory, addClaimHistory, clearClaimHistory } from "./history";
import { getStateStore, STORAGE_KEYS, StateStore, type StateStoreRpc } from "./state";
import { renderDashboard } from "./dashboard";

// Kelas Durable Object wajib diekspor dari main module agar wrangler bisa mengikatnya.
export { StateStore };

function snapshotFromDetails(details?: Record<string, unknown>): UserSnapshot | null {
  if (!details || details.id == null) return null;
  const quota = Number(details.quota ?? 0);
  return {
    id: Number(details.id),
    username: String(details.username ?? ""),
    displayName: String(details.displayName ?? details.username ?? ""),
    githubId: String(details.githubId ?? ""),
    quota,
    usedQuota: Number(details.usedQuota ?? 0),
    balance: balanceFromQuota(quota),
    lastLoginTime: details.lastLoginTime as number | undefined,
  };
}

function snapshotFromRawUser(user: any): UserSnapshot | null {
  if (!user || user.id == null) return null;
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

async function persistOutcome(store: StateStoreRpc, outcome: ClaimOutcome): Promise<void> {
  if (!outcome.session) return;
  const quota = Number(outcome.result.details?.quota);
  await store.saveSession(
    outcome.session,
    Number.isFinite(quota) ? quota : null,
    snapshotFromDetails(outcome.result.details)
  );
}

/**
 * OAuth penuh (Browser Run utama, fallback Pure HTTP) + simpan sesi baru.
 */
async function fullClaim(
  env: Env,
  store: StateStoreRpc,
  opts: { quotaBefore?: number | null; quotaBeforeFresh?: boolean }
): Promise<ClaimResult> {
  if (env.BROWSER) {
    const outcome = await browserClaim(env, opts);
    if (outcome.result.success) {
      await persistOutcome(store, outcome).catch((err) => console.error("Save session error:", err));
      return outcome.result;
    }
    console.log("[CLAIM] Browser Run gagal, fallback ke Pure HTTP:", outcome.result.message);
    const httpOutcome = await executeDailyClaim(env, opts);
    if (httpOutcome.result.success) {
      await persistOutcome(store, httpOutcome).catch((err) => console.error("Save session error:", err));
    }
    return httpOutcome.result;
  }

  const httpOutcome = await executeDailyClaim(env, opts);
  if (httpOutcome.result.success) {
    await persistOutcome(store, httpOutcome).catch((err) => console.error("Save session error:", err));
  }
  return httpOutcome.result;
}

/**
 * Jalankan klaim dengan urutan hemat kuota Browser Run:
 * 1. Lock anti-eksekusi-ganda (cron & trigger manual bisa bertabrakan).
 * 2. QUICK CHECK: jika ada sesi tersimpan, cukup 1 halaman browser untuk cek
 *    last_login_time — bila sudah hari ini, reward sudah aktif → selesai.
 * 3. Jika belum: OAuth penuh dengan baseline quota segar → verifikasi kenaikan $25.
 */
async function runClaim(env: Env): Promise<ClaimResult> {
  const store = getStateStore(env);

  const locked = await store.acquireLock(10 * 60 * 1000);
  if (!locked) {
    return {
      success: false,
      skipped: true,
      message: "Eksekusi klaim lain sedang berjalan — permintaan ini dilewati.",
      statusCode: 429,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const session = (await store.getJson(STORAGE_KEYS.session)) as StoredSession | null;
    const storedQuota = (await store.getJson(STORAGE_KEYS.lastQuota)) as number | null;

    if (env.BROWSER && session?.cookie) {
      console.log("[CLAIM] Quick check sesi tersimpan...");
      const check = await browserCheckSession(env, session);

      if (check.status === "valid" && check.user) {
        if (isTimestampToday(check.user.last_login_time)) {
          // Reward hari ini sudah aktif — tidak perlu OAuth, hemat kuota browser.
          const quota = check.user.quota ?? 0;
          const snapshot = snapshotFromRawUser(check.user);
          await store
            .saveSession(session, quota, snapshot)
            .catch((err) => console.error("Save session error:", err));
          return {
            success: true,
            alreadyClaimed: true,
            verified: false,
            message: `Reward hari ini sudah aktif (cepat via sesi tersimpan, tanpa OAuth). Saldo ${balanceFromQuota(quota)}.`,
            statusCode: 200,
            balance: balanceFromQuota(quota),
            details: { ...(snapshot as object), lastLoginTime: check.user.last_login_time, via: "Quick Check" },
            timestamp: new Date().toISOString(),
          };
        }
        // Sesi hidup tapi reward belum aktif → lanjut OAuth dengan baseline segar
        return fullClaim(env, store, { quotaBefore: check.user.quota ?? null, quotaBeforeFresh: true });
      }

      if (check.status === "invalid") {
        await store.clearSession().catch(() => {});
        console.log("[CLAIM] Sesi tersimpan tidak valid — lanjut OAuth penuh.");
      } else {
        console.log("[CLAIM] Quick check error (WAF/koneksi):", check.message, "— lanjut OAuth penuh.");
      }
    }

    // Tanpa sesi (baru/error): baseline dari storage (bisa basi → verified tidak diklaim)
    return fullClaim(env, store, { quotaBefore: session ? storedQuota : null, quotaBeforeFresh: false });
  } finally {
    await store.releaseLock().catch(() => {});
  }
}

/** Baca state DO secara toleran (dashboard tetap render walau binding bermasalah). */
async function safeGetState(env: Env): Promise<{ session: StoredSession | null; snapshot: UserSnapshot | null }> {
  try {
    const store = getStateStore(env);
    const session = (await store.getJson(STORAGE_KEYS.session)) as StoredSession | null;
    const snapshot = (await store.getJson(STORAGE_KEYS.user)) as UserSnapshot | null;
    return { session, snapshot };
  } catch {
    return { session: null, snapshot: null };
  }
}

const CRONS = ["0 1 * * *", "0 7 * * *"];

/** Endpoint yang memakai/mengubah resource — wajib key bila TRIGGER_AUTH_KEY disetel. */
const PROTECTED_PATHS = new Set([
  "/trigger",
  "/claim",
  "/debug",
  "/diagnose",
  "/debug-browser",
  "/clean-history",
  "/reset",
  "/api/history",
]);

function isAuthorized(request: Request, env: Env, url: URL): boolean {
  if (!env.TRIGGER_AUTH_KEY) return true;
  const key = url.searchParams.get("key") || request.headers.get("x-auth-key");
  return key === env.TRIGGER_AUTH_KEY;
}

export default {
  /**
   * Cron Trigger: 08:00 WIB + retry 14:00 WIB. Setiap eksekusi dimulai
   * dengan cek murah (tanpa browser): bila last_login hari ini sudah tercatat,
   * langsung skip sehingga retry tidak membakar kuota Browser Run.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("[CRON] Trigger diterima, cek status klaim hari ini...");
    try {
      const store = getStateStore(env);
      const snapshot = (await store.getJson(STORAGE_KEYS.user)) as UserSnapshot | null;
      if (snapshot && isTimestampToday(snapshot.lastLoginTime)) {
        console.log("[CRON] Reward hari ini sudah aktif (last_login_time hari ini) — dilewati.");
        return;
      }
    } catch (err) {
      console.error("[CRON] Gagal membaca state DO:", err);
    }

    const result = await runClaim(env);
    console.log(`[CRON] Hasil: ${result.success ? "SUCCESS" : "FAILED"} - ${result.message}`);

    if (!result.skipped) {
      await addClaimHistory(env, result);
    }
    ctx.waitUntil(notify(env, result));
  },

  /**
   * HTTP Fetch Handler (Web Dashboard & API Trigger)
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const jsonHeaders = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };

    if (PROTECTED_PATHS.has(path) && !isAuthorized(request, env, url)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Unauthorized: Invalid or missing key (?key=... atau header x-auth-key).",
        }),
        { status: 401, headers: jsonHeaders }
      );
    }

    // Health check
    if (path === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          timestamp: new Date().toISOString(),
          crons: CRONS,
        }),
        { status: 200, headers: jsonHeaders }
      );
    }

    // Endpoint diagnosa koneksi (tanpa membocorkan secret)
    if (path === "/debug" || path === "/diagnose") {
      const report = await diagnose(env);
      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    // Endpoint diagnosa alur browser (menghabiskan kuota Browser Run, gunakan hemat)
    if (path === "/debug-browser") {
      const report = await diagnoseBrowser(env);
      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    // API History
    if (path === "/api/history") {
      const logs = await getClaimHistory(env);
      return new Response(JSON.stringify(logs, null, 2), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    // Endpoint reset riwayat
    if (path === "/clean-history" || path === "/reset") {
      await clearClaimHistory(env);
      return new Response(
        JSON.stringify(
          {
            success: true,
            message: "Riwayat log dibersihkan. Sesi & snapshot user tetap tersimpan. Gunakan /trigger untuk klaim manual.",
          },
          null,
          2
        ),
        { status: 200, headers: jsonHeaders }
      );
    }

    // Trigger Claim Endpoint (/trigger atau /claim)
    if (path === "/trigger" || path === "/claim") {
      const result = await runClaim(env);

      if (!result.skipped) {
        await addClaimHistory(env, result);
      }

      const shouldNotify = url.searchParams.get("notify") === "true";
      if (shouldNotify) {
        ctx.waitUntil(notify(env, result));
      }

      return new Response(JSON.stringify(result, null, 2), {
        status: result.success ? 200 : 500,
        headers: jsonHeaders,
      });
    }

    // Default: Web Dashboard (murni baca — tanpa efek samping klaim)
    const logs = await getClaimHistory(env);
    const { session, snapshot } = await safeGetState(env);

    // Info live via HTTP biasa (dari Worker ter-deploy biasanya diblokir WAF → pakai snapshot)
    const live = await getCurrentUserInfo(env, session);
    const liveUser = live
      ? {
          balance: live.balance,
          displayName: live.displayName,
          githubId: live.githubId,
          username: live.username,
          lastLoginTime: live.lastLoginTime,
        }
      : snapshot
        ? {
            balance: snapshot.balance,
            displayName: snapshot.displayName,
            githubId: snapshot.githubId,
            username: snapshot.username,
            lastLoginTime: snapshot.lastLoginTime,
          }
        : undefined;

    const html = renderDashboard(logs, liveUser);

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  },
};
