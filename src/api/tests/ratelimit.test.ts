/**
 * KV token bucket: 120 requests/minute/IP on /api/*, refilling over time,
 * applied before any handler so nothing is ever spent by a limited request.
 */

import { describe, expect, it } from 'vitest';
import { allowRequest, RATE_CAPACITY } from '../ratelimit.ts';
import { handleApiRequest } from '../router.ts';
import { makeTestEnv } from './fakes.ts';
import { envelope } from './helpers.ts';

describe('allowRequest', () => {
  it('allows exactly 120 burst requests, rejects the 121st', async () => {
    const env = makeTestEnv();
    for (let i = 0; i < RATE_CAPACITY; i++) {
      expect(await allowRequest(env, '1.2.3.4'), `request ${i + 1}`).toBe(true);
    }
    expect(await allowRequest(env, '1.2.3.4')).toBe(false);
  });

  it('refills over time (2 tokens per second)', async () => {
    const env = makeTestEnv();
    for (let i = 0; i < RATE_CAPACITY; i++) await allowRequest(env, '1.2.3.4');
    expect(await allowRequest(env, '1.2.3.4')).toBe(false);
    env.clock.advance(1_000); // 1s -> 2 tokens
    expect(await allowRequest(env, '1.2.3.4')).toBe(true);
    expect(await allowRequest(env, '1.2.3.4')).toBe(true);
    expect(await allowRequest(env, '1.2.3.4')).toBe(false);
  });

  it('buckets are per IP', async () => {
    const env = makeTestEnv();
    for (let i = 0; i < RATE_CAPACITY; i++) await allowRequest(env, '1.2.3.4');
    expect(await allowRequest(env, '1.2.3.4')).toBe(false);
    expect(await allowRequest(env, '5.6.7.8')).toBe(true);
  });
});

describe('router integration', () => {
  it('returns the 429 envelope on /api/* and never limits the front door', async () => {
    const env = makeTestEnv();
    for (let i = 0; i < RATE_CAPACITY; i++) {
      await handleApiRequest(env, new Request('https://x/api/pulse', { headers: { 'cf-connecting-ip': '9.9.9.9' } }));
    }
    const limited = await handleApiRequest(env, new Request('https://x/api/pulse', { headers: { 'cf-connecting-ip': '9.9.9.9' } }));
    expect(limited.status).toBe(429);
    const body = await envelope(limited);
    expect(body.error?.code).toBe('RATE_LIMITED');
    expect(body.metadata?.boundary).toBeTruthy();

    const front = await handleApiRequest(env, new Request('https://x/', { headers: { 'cf-connecting-ip': '9.9.9.9' } }));
    expect(front.status).toBe(200);
  });
});
