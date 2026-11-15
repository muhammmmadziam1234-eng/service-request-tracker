export interface ThrottleDecision {allowed: boolean; retryAfterSeconds: number}
export interface LoginThrottle {
  check(key: string): ThrottleDecision;
  fail(key: string): void;
  reset(key: string): void;
  readonly size: number;
}
export interface ThrottleOptions {now?: () => number; limit?: number; windowMs?: number; maxKeys?: number}

/**
 * Sliding-window failure counter held in memory: `limit` failures per `windowMs` for one key (username + address).
 * Blocked attempts are not counted, so hammering a locked account cannot extend the lock. The table is capped.
 */
export function createLoginThrottle({now = Date.now, limit = 5, windowMs = 15 * 60_000, maxKeys = 10_000}: ThrottleOptions = {}): LoginThrottle {
  const failures = new Map<string, number[]>();
  function recent(key: string, t: number): number[] {
    const list = (failures.get(key) ?? []).filter(at => t - at < windowMs);
    if (list.length) failures.set(key, list); else failures.delete(key);
    return list;
  }
  return {
    check(key) {
      const t = now(), list = recent(key, t);
      if (list.length < limit) return {allowed: true, retryAfterSeconds: 0};
      return {allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((list[list.length - limit]! + windowMs - t) / 1000))};
    },
    fail(key) {
      const t = now(), list = recent(key, t);
      list.push(t);
      failures.set(key, list);
      if (failures.size > maxKeys) {
        for (const stale of failures.keys()) { if (failures.size <= maxKeys) break; if (stale !== key) failures.delete(stale); }
      }
    },
    reset(key) { failures.delete(key); },
    get size() { return failures.size; }
  };
}
