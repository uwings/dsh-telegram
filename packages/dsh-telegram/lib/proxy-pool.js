// Proxy health pool for the Telegram Bot API bridge.
//
// Telegram connectivity on this box depends on Clash; the proxy port can stall
// or drop while TUN keeps direct connections working. Instead of pinning one
// proxy, the bridge keeps a small candidate list (HTTP proxy + direct) and
// prefers whichever one last answered a getMe probe.

import { request } from "./proxy-fetch.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 120_000;

export class ProxyPool {
  constructor(candidates, { log = () => {}, probeUrl = "", probeIntervalMs, probeTimeoutMs, ttlMs } = {}) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    const seen = new Set();
    this.candidates = [];
    for (const item of list) {
      const value = item === undefined || item === null ? "" : String(item);
      if (seen.has(value)) continue;
      seen.add(value);
      this.candidates.push(value);
    }
    if (this.candidates.length === 0) this.candidates.push("");
    // Direct is always kept as the last resort: under Clash TUN it usually works.
    if (!this.candidates.includes("")) this.candidates.push("");

    this.log = log;
    this.probeUrl = probeUrl;
    this.intervalMs = probeIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = probeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.health = new Map(); // candidate -> { ok, at, latencyMs, error }
    this.probePromise = null;
    this.probeCount = 0;
    this.timer = null;
    this.rotate = 0;
  }

  label(candidate) {
    return candidate || "direct";
  }

  isFresh(entry) {
    return Boolean(entry) && Date.now() - entry.at < this.ttlMs;
  }

  /** Candidates ordered: healthy first, unknown next, failed last. */
  order() {
    const now = Date.now();
    const healthy = [];
    const unknown = [];
    const failed = [];
    for (const candidate of this.candidates) {
      const entry = this.health.get(candidate);
      if (!entry || !this.isFresh(entry)) unknown.push(candidate);
      else if (entry.ok) healthy.push(candidate);
      else failed.push(candidate);
    }
    const list = [...healthy, ...unknown, ...failed];
    if (list.length > 1) {
      this.rotate = (this.rotate + 1) % list.length;
      return [...list.slice(this.rotate), ...list.slice(0, this.rotate)];
    }
    return list;
  }

  markOk(candidate) {
    const prev = this.health.get(candidate);
    this.health.set(candidate, { ok: true, at: Date.now(), latencyMs: prev?.latencyMs ?? 0, error: "" });
  }

  markFail(candidate, error) {
    const prev = this.health.get(candidate);
    // Only log a transition, not every hiccup.
    if (!prev || prev.ok) this.log(`telegram: proxy ${this.label(candidate)} failed: ${error?.message || error}`);
    this.health.set(candidate, { ok: false, at: Date.now(), latencyMs: 0, error: String(error?.message || error || "") });
  }

  /** Probe every candidate once, in parallel. */
  async probeOnce() {
    if (this.probePromise) return this.probePromise;
    if (!this.probeUrl) return null;
    this.probePromise = (async () => {
      this.probeCount += 1;
      await Promise.all(
        this.candidates.map(async (candidate) => {
          const startedAt = Date.now();
          try {
            const response = await request(this.probeUrl, {
              proxies: [candidate],
              timeoutMs: this.timeoutMs,
            });
            const body = response.json();
            const latencyMs = Date.now() - startedAt;
            const ok = Boolean(body?.ok);
            const prev = this.health.get(candidate);
            this.health.set(candidate, { ok, at: Date.now(), latencyMs, error: ok ? "" : body?.description || "not ok" });
            if (!prev || prev.ok !== ok) {
              this.log(
                ok
                  ? `telegram: proxy ${this.label(candidate)} healthy (${latencyMs}ms)`
                  : `telegram: proxy ${this.label(candidate)} unhealthy: ${body?.description || "not ok"}`
              );
            }
          } catch (error) {
            const prev = this.health.get(candidate);
            this.health.set(candidate, { ok: false, at: Date.now(), latencyMs: 0, error: String(error?.message || error) });
            if (!prev || prev.ok !== false) {
              this.log(`telegram: proxy ${this.label(candidate)} probe failed: ${error?.message || error}`);
            }
          }
        })
      );
      return this.status();
    })().finally(() => {
      this.probePromise = null;
    });
    return this.probePromise;
  }

  /** First-use probe; later calls are free. */
  async ensureProbed() {
    if (this.health.size === 0 && this.probeUrl) await this.probeOnce();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.probeOnce().catch(() => {});
    }, this.intervalMs);
    // Never keep the process alive just for probing.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return this.candidates.map((candidate) => {
      const entry = this.health.get(candidate);
      if (!entry || !this.isFresh(entry)) return `${this.label(candidate)}: unknown`;
      return entry.ok
        ? `${this.label(candidate)}: ok ${entry.latencyMs}ms`
        : `${this.label(candidate)}: fail (${entry.error})`;
    });
  }
}
