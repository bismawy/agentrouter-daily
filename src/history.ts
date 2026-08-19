import { ClaimResult } from "./types";

const CACHE_URL = "https://agentrouter-daily.internal/logs.json";

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
      typeof rawLoginTime === "number" && rawLoginTime < 1e12
        ? rawLoginTime * 1000
        : Number(rawLoginTime);
    if (!isNaN(loginTsMs) && loginTsMs > 0) {
      const loginDateKey = new Date(loginTsMs).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
      if (loginDateKey === todayKey) {
        return true;
      }
    }
  }

  return false;
}

export async function getClaimHistory(): Promise<ClaimResult[]> {
  try {
    const cache = (caches as any).default;
    if (!cache) return [];
    const match = await cache.match(CACHE_URL);
    if (match) {
      const logs = (await match.json().catch(() => [])) as ClaimResult[];
      if (Array.isArray(logs)) {
        return deduplicateByDate(logs);
      }
    }
  } catch (err) {
    console.error("Cache get error:", err);
  }
  return [];
}

export async function addClaimHistory(result: ClaimResult): Promise<void> {
  try {
    const cache = (caches as any).default;
    if (!cache) return;
    const currentLogs = await getClaimHistory();

    const resultDateKey = getDateKey(result.timestamp);

    // Hapus log lama pada tanggal yang sama, sisakan hasil terbaru saja
    const filteredLogs = currentLogs.filter((l) => getDateKey(l.timestamp) !== resultDateKey);
    const updatedLogs = deduplicateByDate([result, ...filteredLogs]).slice(0, 30);

    const response = new Response(JSON.stringify(updatedLogs), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=2592000",
      },
    });

    await cache.put(CACHE_URL, response);
  } catch (err) {
    console.error("Cache put error:", err);
  }
}

export async function clearClaimHistory(): Promise<void> {
  try {
    const cache = (caches as any).default;
    if (!cache) return;
    await cache.delete(CACHE_URL);
  } catch (err) {
    console.error("Cache clear error:", err);
  }
}

export async function setClaimHistory(logs: ClaimResult[]): Promise<void> {
  try {
    const cache = (caches as any).default;
    if (!cache) return;
    const uniqueLogs = deduplicateByDate(logs).slice(0, 30);
    const response = new Response(JSON.stringify(uniqueLogs), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=2592000",
      },
    });
    await cache.put(CACHE_URL, response);
  } catch (err) {
    console.error("Cache set error:", err);
  }
}
