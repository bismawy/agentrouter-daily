import { Env, ClaimResult } from "./types";
import { getStateStore, STORAGE_KEYS } from "./state";

function getDateKey(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

export function deduplicateByDate(logs: ClaimResult[]): ClaimResult[] {
  const seenDates = new Set<string>();
  const unique: ClaimResult[] = [];
  for (const log of logs) {
    const dateKey = getDateKey(log.timestamp);
    if (!seenDates.has(dateKey)) {
      seenDates.add(dateKey);
      unique.push(log);
    }
  }
  return unique;
}

export function isClaimedToday(logs: ClaimResult[], lastLoginTimestamp?: number | string): boolean {
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });

  // 1. Cek dari log riwayat yang berstatus sukses
  const fromLogs = logs.some((l) => l.success && getDateKey(l.timestamp) === todayKey);
  if (fromLogs) return true;

  // 2. Cek langsung dari timestamp last_login_time akun AgentRouter
  const rawLoginTime =
    lastLoginTimestamp ??
    (logs[0]?.details?.lastLoginTime as number | undefined) ??
    (logs[0]?.details?.last_login_time as number | undefined);

  if (rawLoginTime) {
    const loginTsMs =
      typeof rawLoginTime === "number" && rawLoginTime < 1e12 ? rawLoginTime * 1000 : Number(rawLoginTime);
    if (!isNaN(loginTsMs) && loginTsMs > 0) {
      const loginDateKey = new Date(loginTsMs).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
      if (loginDateKey === todayKey) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Riwayat klaim disimpan di Durable Object (strongly consistent, tidak bisa
 * ter-evict sembarangan) — menggantikan Cache API yang per-colo & best-effort.
 */
export async function getClaimHistory(env: Env): Promise<ClaimResult[]> {
  try {
    const store = getStateStore(env);
    const logs = await store.getJson(STORAGE_KEYS.history);
    return Array.isArray(logs) ? deduplicateByDate(logs as ClaimResult[]) : [];
  } catch (err) {
    console.error("History get error:", err);
    return [];
  }
}

export async function addClaimHistory(env: Env, result: ClaimResult): Promise<void> {
  try {
    const store = getStateStore(env);
    const currentLogs = await getClaimHistory(env);

    // Hapus log lama pada tanggal yang sama, sisakan hasil terbaru saja
    const resultDateKey = getDateKey(result.timestamp);
    const filteredLogs = currentLogs.filter((l) => getDateKey(l.timestamp) !== resultDateKey);
    const updatedLogs = deduplicateByDate([result, ...filteredLogs]).slice(0, 30);

    await store.putJson(STORAGE_KEYS.history, updatedLogs);
  } catch (err) {
    console.error("History put error:", err);
  }
}

export async function clearClaimHistory(env: Env): Promise<void> {
  try {
    const store = getStateStore(env);
    await store.deleteJson(STORAGE_KEYS.history);
  } catch (err) {
    console.error("History clear error:", err);
  }
}
