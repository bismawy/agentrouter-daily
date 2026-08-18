import { ClaimResult } from "./types";

const CACHE_URL = "https://agentrouter-autoclaim.internal/logs.json";

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

export function isClaimedToday(logs: ClaimResult[]): boolean {
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
  return logs.some((l) => l.success && getDateKey(l.timestamp) === todayKey);
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
