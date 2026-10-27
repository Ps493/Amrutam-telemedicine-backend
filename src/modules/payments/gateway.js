'use strict';
const crypto = require('crypto');
const { withRetry, CircuitBreaker } = require('../../lib/retry');

// Payment provider port. A real adapter (Razorpay/Stripe) implements charge/refund with provider-side idempotency keys.
// Errors carry `.transient` (retry-able: timeouts/5xx) vs permanent (card declined).
class MockGateway {
  constructor() { this.charges = new Map(); this.flaky = new Map(); this.calls = 0; }
  async charge({ amountPaise, idempotencyKey, token }) {
    this.calls += 1;
    if (this.charges.has(idempotencyKey)) return this.charges.get(idempotencyKey); // provider-side idempotency
    if (token === 'tok_declined') { const e = new Error('card declined'); e.transient = false; throw e; }
    if (token === 'tok_flaky') {
      const n = (this.flaky.get(idempotencyKey) || 0) + 1; this.flaky.set(idempotencyKey, n);
      if (n <= 2) { const e = new Error('gateway timeout'); e.transient = true; throw e; }
    }
    if (token === 'tok_down') { const e = new Error('gateway unavailable'); e.transient = true; throw e; }
    const res = { providerRef: `ch_${crypto.randomBytes(8).toString('hex')}`, amountPaise };
    this.charges.set(idempotencyKey, res);
    return res;
  }
  async refund({ providerRef }) { if (!providerRef) throw new Error('missing ref'); return { refundRef: `re_${crypto.randomBytes(6).toString('hex')}` }; }
}

// Resilient wrapper: retries transient errors with exponential backoff + full jitter, guarded by a circuit breaker.
function createResilientGateway(inner, { retries = 3, baseMs = 100, breaker = new CircuitBreaker({ threshold: 8, cooldownMs: 15000 }) } = {}) {
  const call = (fn) => breaker.exec(() => withRetry(fn, { retries, baseMs, shouldRetry: (e) => e.transient === true }));
  return {
    charge: (a) => call(() => inner.charge(a)),
    refund: (a) => call(() => inner.refund(a)),
    breaker,
  };
}
module.exports = { MockGateway, createResilientGateway };
