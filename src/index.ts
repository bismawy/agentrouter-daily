import { Env, ClaimResult } from "./types";
import { executeDailyClaim, getCurrentUserInfo, diagnose } from "./agentrouter";
import { browserClaim, diagnoseBrowser } from "./browser-claim";
import { notify } from "./notifier";
import { getClaimHistory, addClaimHistory, setClaimHistory, clearClaimHistory } from "./history";
import { renderDashboard } from "./dashboard";

/**
 * Jalankan klaim: Browser Run (lolos WAF) jika tersedia, fallback ke Pure HTTP OAuth.
 */
async function runClaim(env: Env): Promise<ClaimResult> {
  if (env.BROWSER) {
    const res = await browserClaim(env);
    if (res.success) return res;
    console.log("[CLAIM] Browser Run gagal, fallback ke Pure HTTP:", res.message);
  }
  return executeDailyClaim(env);
}

export default {
  /**
   * Cron Trigger Scheduled Handler (dijalankan otomatis setiap hari pukul 08:00 WIB)
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("[CRON] Memulai eksekusi auto-claim AgentRouter harian...");
    const result = await runClaim(env);
    console.log(`[CRON] Hasil: ${result.success ? "SUCCESS" : "FAILED"} - ${result.message}`);

    // Simpan ke riwayat logs (otomatis menggantikan entri hari yang sama jika sudah ada)
    await addClaimHistory(result);

    // Kirim notifikasi jika Telegram/Discord disetel
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

    // Health check
    if (path === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          timestamp: new Date().toISOString(),
          cron: "0 1 * * *",
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
      const logs = await getClaimHistory();
      return new Response(JSON.stringify(logs, null, 2), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    // Endpoint reset/clean riwayat (misal /clean-history atau /reset)
    if (path === "/clean-history" || path === "/reset") {
      await clearClaimHistory();

      let claimEntry: ClaimResult | null = null;
      if (env.GITHUB_COOKIE?.trim()) {
        claimEntry = await runClaim(env);
      }

      if (!claimEntry || !claimEntry.success) {
        const currentUser = await getCurrentUserInfo(env);
        if (currentUser) {
          claimEntry = {
            success: true,
            message: `Riwayat dibersihkan. Saldo aktif tersinkronisasi: ${currentUser.displayName} (${currentUser.githubId}).`,
            balance: currentUser.balance,
            statusCode: 200,
            details: {
              id: currentUser.id,
              username: currentUser.username,
              displayName: currentUser.displayName,
              githubId: currentUser.githubId,
              quota: currentUser.quota,
              usedQuota: currentUser.usedQuota,
            },
            timestamp: new Date().toISOString(),
          };
        }
      }

      if (claimEntry && claimEntry.balance) {
        await setClaimHistory([claimEntry]);
      }

      return new Response(
        JSON.stringify(
          {
            success: true,
            message: "Riwayat log berhasil dibersihkan dan disinkronkan dengan saldo terkini.",
            balance: claimEntry?.balance || "$0.00 USD",
            logs: claimEntry ? [claimEntry] : [],
          },
          null,
          2
        ),
        { status: 200, headers: jsonHeaders }
      );
    }

    // Trigger Claim Endpoint (/trigger atau /claim)
    if (path === "/trigger" || path === "/claim") {
      if (env.TRIGGER_AUTH_KEY) {
        const providedKey = url.searchParams.get("key") || request.headers.get("x-auth-key");
        if (providedKey !== env.TRIGGER_AUTH_KEY) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "Unauthorized: Invalid or missing trigger key.",
            }),
            { status: 401, headers: jsonHeaders }
          );
        }
      }

      const result = await runClaim(env);

      // Update riwayat tanpa spamming entri ganda per hari
      await addClaimHistory(result);

      // Kirim notifikasi jika disetel
      const shouldNotify = url.searchParams.get("notify") === "true";
      if (shouldNotify) {
        ctx.waitUntil(notify(env, result));
      }

      return new Response(JSON.stringify(result, null, 2), {
        status: result.success ? 200 : 500,
        headers: jsonHeaders,
      });
    }

    // Default: Web Dashboard (Tabel Status & Riwayat Monochrome)
    const logs = await getClaimHistory();
    let liveUser = undefined;
    const current = await getCurrentUserInfo(env);
    if (current) {
      liveUser = {
        balance: current.balance,
        displayName: current.displayName,
        githubId: current.githubId,
        username: current.username,
        lastLoginTime: current.lastLoginTime,
      };
    }

    if (logs.length > 0) {
      await setClaimHistory(logs);
    }

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
