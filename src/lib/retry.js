'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with FULL jitter: delay = random(0, min(cap, base * 2^attempt)).
// Jitter prevents synchronized retry storms against a recovering dependency.
function backoffDelay(attempt, baseMs = 100, capMs = 5000, rand = Math.random) {
  return Math.floor(rand() * Math.min(capMs, baseMs * 2 ** attempt));
}

async function withRetry(fn, { retries = 3, baseMs = 100, capMs = 5000, shouldRetry = () => true, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try { return await fn(attempt); } catch (e) {
      if (attempt >= retries || !shouldRetry(e)) throw e;
      if (onRetry) onRetry(e, attempt);
      await sleep(backoffDelay(attempt, baseMs, capMs));
      attempt += 1;
    }
  }
}

// Minimal circuit breaker: opens after N consecutive failures, half-opens after cooldown.
class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 10_000 } = {}) { this.threshold = threshold; this.cooldownMs = cooldownMs; this.failures = 0; this.openedAt = 0; }
  get state() { if (this.failures < this.threshold) return 'closed'; return Date.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'; }
  async exec(fn) {
    if (this.state === 'open') { const e = new Error('circuit open'); e.circuitOpen = true; throw e; }
    try { const r = await fn(); this.failures = 0; return r; }
    catch (e) { this.failures += 1; if (this.failures >= this.threshold) this.openedAt = Date.now(); throw e; }
  }
}
module.exports = { withRetry, backoffDelay, CircuitBreaker, sleep };
