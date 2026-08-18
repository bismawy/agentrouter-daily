import { Env } from "./types";
import { executeDailyClaim } from "./agentrouter";
import { notify } from "./notifier";
import { getClaimHistory, addClaimHistory, setClaimHistory, isClaimedToday } from "./history";
import { renderDashboard } from "./dashboard";

export default {
  /**
   * Cron Trigger Scheduled Handler (dijalankan otomatis setiap hari pukul 08:00 WIB)
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("[CRON] Memulai eksekusi auto-claim AgentRouter harian...");
    const result = await executeDailyClaim(env);
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

    // API History
    if (path === "/api/history") {
      const logs = await getClaimHistory();
      return new Response(JSON.stringify(logs, null, 2), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    // Endpoint reset/clean riwayat (misal /clean-history)
    if (path === "/clean-history" || path === "/reset") {
      const logs = await getClaimHistory();
      const cleaned = logs.slice(0, 1);
      await setClaimHistory(cleaned);
      return new Response(JSON.stringify({ success: true, logs: cleaned }, null, 2), {
        status: 200,
        headers: jsonHeaders,
      });
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

      const logs = await getClaimHistory();
      const alreadyClaimed = isClaimedToday(logs);

      const result = await executeDailyClaim(env);
      result.alreadyClaimed = alreadyClaimed;

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
    // Sinkronisasi cache agar hanya tersimpan 1 log per tanggal
    if (logs.length > 0) {
      await setClaimHistory(logs);
    }

    const html = renderDashboard(logs);

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  },
};
