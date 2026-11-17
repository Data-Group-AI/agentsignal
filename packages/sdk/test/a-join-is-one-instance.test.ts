import { describe, expect, it, vi } from 'vitest';
import { AgentSelf } from '../src/index.js';

/**
 * F1, 2026-11-14. The server refuses a join that names an existing handle
 * unless it proves possession -- or is a retry of the same join, which it
 * recognises by the instance_id already being that agent's device. So every
 * attempt of one join call must carry the same instance_id, and a caller that
 * sets its own keeps it.
 */

const BASE = 'https://api.example.test';
/** A FAKE join code, built at runtime: as_join_<channel>_<secret>. */
const FAKE_CODE = ['as', 'join', 'chan0001', 'x'.repeat(8)].join('_');
const SECRET = (d: string) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}.${'ab'.repeat(32)}`;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('joining with a code', () => {
  it('sends one instance_id on every attempt of one join', async () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? reply(503, { ok: false, error: { code: 'internal', message: 'lost' } })
        : reply(201, {
            ok: true,
            created: true,
            agent: { key: 'u_x', handle: 'retry-bot' },
            device_secret: SECRET('1'),
          });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await AgentSelf.join(FAKE_CODE, { handle: 'retry-bot' }, {
        baseUrl: BASE,
        fetch: impl as unknown as typeof globalThis.fetch,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(bodies).toHaveLength(2);
    expect(bodies[0].instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[1].instance_id, 'a retry is the same instance').toBe(bodies[0].instance_id);
    expect(bodies[0].join_attempt).toMatch(/^[0-9a-f]{64}$/);
    expect(bodies[1].join_attempt, 'a retry repeats the attempt secret').toBe(bodies[0].join_attempt);
  });

  it('gives a fresh attempt secret to every join call, not one per process', async () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(201, { ok: true, created: true, agent: { key: 'u_x', handle: 'two-calls' }, device_secret: SECRET('5') });
    });
    const options = { baseUrl: BASE, fetch: impl as unknown as typeof globalThis.fetch };
    await AgentSelf.join(FAKE_CODE, { handle: 'two-calls' }, options);
    await AgentSelf.join(FAKE_CODE, { handle: 'two-calls' }, options);
    expect(bodies[0].join_attempt).not.toBe(bodies[1].join_attempt);
    expect(bodies[0].instance_id).not.toBe(bodies[1].instance_id);
  });

  /** Review logic#3: `instance_id: undefined` used to erase the default. */
  it('keeps the generated instance when the caller passes instance_id: undefined', async () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(201, { ok: true, created: true, agent: { key: 'u_x', handle: 'undef-bot' }, device_secret: SECRET('6') });
    });
    await AgentSelf.join(FAKE_CODE, { handle: 'undef-bot', instance_id: undefined }, {
      baseUrl: BASE,
      fetch: impl as unknown as typeof globalThis.fetch,
    });
    expect(bodies[0].instance_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the caller's own instance_id and passes the held credential", async () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(200, {
        ok: true,
        created: false,
        agent: { key: 'u_x', handle: 'own-bot' },
        device_secret: SECRET('2'),
      });
    });
    const held = SECRET('3');

    await AgentSelf.join(
      FAKE_CODE,
      {
        handle: 'own-bot',
        instance_id: '44444444-4444-4444-8444-444444444444',
        current_credential: held,
      },
      { baseUrl: BASE, fetch: impl as unknown as typeof globalThis.fetch },
    );

    expect(bodies[0].instance_id).toBe('44444444-4444-4444-8444-444444444444');
    expect(bodies[0].current_credential).toBe(held);
  });
});
