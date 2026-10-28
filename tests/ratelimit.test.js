'use strict';
// Enable the limiter for this file only (env.js disables it elsewhere). Must be set BEFORE modules load.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_AUTH_MAX = '3';
const h = require('./helpers');

let ctx;
beforeAll(async () => { ctx = await h.setup(); });
afterAll(async () => { await ctx.container.close(); });

test('auth endpoints are rate limited (429 + RATE_LIMITED) after the threshold', async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await ctx.api.post('/v1/auth/login').send({ email: 'nobody@example.com', password: 'Whatever-1234' })).status);
  expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
  expect(codes.slice(3)).toEqual([429, 429]);
  const r = await ctx.api.post('/v1/auth/login').send({ email: 'nobody@example.com', password: 'x' });
  expect(r.body.error.code).toBe('RATE_LIMITED');
  expect(r.headers['ratelimit-limit'] || r.headers['ratelimit']).toBeTruthy(); // standard headers exposed
});

test('redis cache module loads (ioredis installed) and degrades safely when Redis is down', async () => {
  const { createCache } = require('../src/lib/cache');
  const c = createCache('redis://127.0.0.1:6399'); // nothing listens here
  expect(c.constructor.name).toBe('RedisCache');
  expect(await c.get('k')).toBeNull();      // must not throw
  await c.set('k', { a: 1 }, 5);            // must not throw
  await c.close();
});
