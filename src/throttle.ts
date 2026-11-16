export interface ThrottleDecision {allowed: boolean; retryAfterSeconds: number}
export interface LoginThrottle {
  check(key: string): ThrottleDecision;
  /**
   * Asks permission for one attempt and, when it is allowed, counts it straight away. Use this before the slow password check:
   * counting only afterwards lets a burst of parallel attempts all pass the check first. Call reset() after a successful sign-in.
   */
  begin(key: string): ThrottleDecision;
  fail(key: string): void;
  reset(key: string): void;
  readonly size: number;
}
export interface ThrottleOptions {now?: () => number; limit?: number; windowMs?: number; maxKeys?: number}

/**
 * Sliding-window attempt counter held in memory: `limit` attempts per `windowMs` for one key (username + address). An attempt is
 * counted when it starts and cleared by a successful sign-in, so the limit holds even when attempts arrive in parallel.
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
    begin(key) {
      const decision = this.check(key);
      if (decision.allowed) this.fail(key);
      return decision;
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
