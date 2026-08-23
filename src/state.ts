import { DurableObject } from "cloudflare:workers";
import { Env, StoredSession, UserSnapshot } from "./types";

export const STORAGE_KEYS = {
  history: "history",
  session: "session",
  user: "user",
  lastQuota: "lastQuota",
} as const;

/**
 * Durable Object penyimpanan state worker: sesi AgentRouter, snapshot user,
 * riwayat klaim, dan lock anti-eksekusi-ganda. SQLite-backed (new_sqlite_classes)
 * agar bisa dipakai di Workers Free Plan. Dipanggil lewat RPC (getStateStore).
 */
export class StateStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("OK", { status: 200 });
  }

  async getJson(key: string): Promise<unknown> {
    return (await this.ctx.storage.get(key)) ?? null;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  async deleteJson(key: string): Promise<void> {
    await this.ctx.storage.delete(key);
  }

  async saveSession(session: StoredSession, quota: number | null, user: UserSnapshot | null): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEYS.session, session);
    if (quota != null) await this.ctx.storage.put(STORAGE_KEYS.lastQuota, quota);
    if (user) await this.ctx.storage.put(STORAGE_KEYS.user, user);
  }

  async clearSession(): Promise<void> {
    await this.ctx.storage.delete(STORAGE_KEYS.session);
  }

  /**
   * Lock atomic (Durable Object memproses satu request dalam satu waktu per objek).
   * TTL menjaga lock tidak macet selamanya bila proses crash di tengah jalan.
   */
  async acquireLock(ttlMs = 600000): Promise<boolean> {
    const now = Date.now();
    const heldAt = await this.ctx.storage.get<number>("lock");
    if (heldAt && now - heldAt < ttlMs) return false;
    await this.ctx.storage.put("lock", now);
    return true;
  }

  async releaseLock(): Promise<void> {
    await this.ctx.storage.delete("lock");
  }
}

export interface StateStoreRpc {
  getJson(key: string): Promise<any>;
  putJson(key: string, value: unknown): Promise<void>;
  deleteJson(key: string): Promise<void>;
  saveSession(session: StoredSession, quota: number | null, user: UserSnapshot | null): Promise<void>;
  clearSession(): Promise<void>;
  acquireLock(ttlMs?: number): Promise<boolean>;
  releaseLock(): Promise<void>;
}

export function getStateStore(env: Env): StateStoreRpc {
  if (!env.STATE) {
    throw new Error("Binding STATE (Durable Object) belum dikonfigurasi di wrangler.toml.");
  }
  const id = env.STATE.idFromName("default");
  return env.STATE.get(id) as unknown as StateStoreRpc;
}
