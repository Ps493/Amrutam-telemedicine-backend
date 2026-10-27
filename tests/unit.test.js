'use strict';
const { canTransition } = require('../src/modules/consultations/stateMachine');
const { backoffDelay, withRetry, CircuitBreaker } = require('../src/lib/retry');
const { encrypt, decrypt, needsRotation } = require('../src/lib/crypto');
const { can } = require('../src/lib/rbac');

describe('state machine', () => {
  test('allows the happy path', () => {
    expect(canTransition('PENDING_PAYMENT', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });
  test('rejects illegal transitions', () => {
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('PENDING_PAYMENT', 'COMPLETED')).toBe(false);
    expect(canTransition('EXPIRED', 'CONFIRMED')).toBe(false);
  });
});

describe('retry / backoff', () => {
  test('backoff is exponential, capped, and jittered', () => {
    expect(backoffDelay(0, 100, 5000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 5000, () => 1)).toBe(800);
    expect(backoffDelay(20, 100, 5000, () => 1)).toBe(5000);
    expect(backoffDelay(3, 100, 5000, () => 0)).toBe(0);
  });
  test('retries only retryable errors', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw Object.assign(new Error('x'), { transient: false }); }, { retries: 3, baseMs: 1, shouldRetry: (e) => e.transient })).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    const v = await withRetry(async () => { if (++calls < 3) throw Object.assign(new Error('t'), { transient: true }); return 'ok'; }, { retries: 3, baseMs: 1, shouldRetry: (e) => e.transient });
    expect(v).toBe('ok'); expect(calls).toBe(3);
  });
  test('circuit breaker opens after threshold', async () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 60000 });
    for (let i = 0; i < 2; i++) await b.exec(async () => { throw new Error('boom'); }).catch(() => {});
    await expect(b.exec(async () => 1)).rejects.toMatchObject({ circuitOpen: true });
  });
});

describe('field encryption', () => {
  test('round trips and is non-deterministic', () => {
    const a = encrypt('secret', 'aad'); const b = encrypt('secret', 'aad');
    expect(a).not.toEqual(b); expect(decrypt(a, 'aad')).toBe('secret'); expect(needsRotation(a)).toBe(false);
  });
  test('AAD binding prevents ciphertext swapping', () => { expect(() => decrypt(encrypt('x', 'row1'), 'row2')).toThrow(); });
  test('detects tampering', () => { const e = encrypt('x', 'a').split(':'); e[3] = Buffer.from('zzzz').toString('base64'); expect(() => decrypt(e.join(':'), 'a')).toThrow(); });
});

describe('rbac', () => {
  test('matrix', () => {
    expect(can('patient', 'consultation:book')).toBe(true);
    expect(can('patient', 'slot:manage_own')).toBe(false);
    expect(can('doctor', 'admin:analytics')).toBe(false);
    expect(can('admin', 'admin:analytics')).toBe(true);
    expect(can('nobody', 'profile:read')).toBe(false);
  });
});
