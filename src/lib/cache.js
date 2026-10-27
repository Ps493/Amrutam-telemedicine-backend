'use strict';
// Cache abstraction: in-memory TTL cache by default; Redis is optional via REDIS_URL (cache-aside pattern).
class MemoryCache {
  constructor() { this.m = new Map(); }
  async get(k) { const e = this.m.get(k); if (!e) return null; if (e.exp < Date.now()) { this.m.delete(k); return null; } return e.v; }
  async set(k, v, ttlSec) { this.m.set(k, { v, exp: Date.now() + ttlSec * 1000 }); if (this.m.size > 5000) this.m.delete(this.m.keys().next().value); }
  async del(prefix) { for (const k of this.m.keys()) if (k.startsWith(prefix)) this.m.delete(k); }
  async close() {}
}
class RedisCache {
  constructor(url) { const Redis = require('ioredis'); this.r = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false }); this.r.on('error', () => {}); }
  async get(k) { try { const v = await this.r.get(k); return v ? JSON.parse(v) : null; } catch { return null; } } // cache failure must never fail a request
  async set(k, v, ttl) { try { await this.r.set(k, JSON.stringify(v), 'EX', ttl); } catch { /* ignore */ } }
  async del(prefix) { try { const keys = await this.r.keys(`${prefix}*`); if (keys.length) await this.r.del(keys); } catch { /* ignore */ } }
  async close() { this.r.disconnect(); }
}
function createCache(url) {
  if (url) { try { return new RedisCache(url); } catch { /* ioredis not installed -> fallback */ } }
  return new MemoryCache();
}

// Cache-aside with single-flight (request coalescing) to prevent cache stampede, plus TTL jitter.
const inflight = new Map();
async function cached(cache, key, ttlSec, loader) {
  const hit = await cache.get(key);
  if (hit !== null) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { const v = await loader(); await cache.set(key, v, Math.round(ttlSec * (0.9 + Math.random() * 0.2))); return v; }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}
module.exports = { createCache, cached, MemoryCache };
