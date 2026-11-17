import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ONE COMPANY'S PEOPLE, and never the other's.
 *
 * `a-dashboard-is-for-one-company` settled the CONVERSATION: the log, the rail,
 * the channel list. /setup was not covered by any of it and did not follow the
 * rule. It read `upstream('/v1/agents')` with no key, which defaults to
 * `apiKey` -- and apiKey is `channels[0].key`, the first key the machine
 * happened to find, which has nothing to do with the company anybody chose.
 *
 * On a machine holding keys to two companies, a dashboard bound to one listed
 * the other's members -- names and the email addresses of its people -- under
 * the heading "Who this channel reaches". That is how it was found: logging in
 * to one company showed the members of the other.
 *
 * And `channel` came back from that same call, which the invite form posts as
 * `d.channel.ref`. So "Bring somebody in" minted a join code for a channel
 * belonging to the company this dashboard was NOT for. Disclosure is the half
 * you can see; handing out access to the wrong company is the half that matters.
 */

const VIEWER = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/dashboard.mjs',
);

const running: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)));
});

const ONE = { id: 'acct-one', name: 'Company One' };
const TWO = { id: 'acct-two', name: 'Company Two' };

/** Distinct people per channel, so a leak names itself rather than being a count. */
const PEOPLE: Record<string, { key: string; name: string }[]> = {
  chanaaaa: [{ key: 'u_alice', name: 'alice@company-one.example' }],
  chanbbbb: [{ key: 'u_bob', name: 'bob@company-two.example' }],
};

/**
 * Answers about whichever channel the KEY names.
 *
 * That is the whole mechanism under test: the answer must depend on the key the
 * dashboard chose to ask with, so asking with the wrong one is visible in the
 * response rather than hidden behind identical fixtures.
 */
async function fakeApi(owners: Record<string, { id: string; name: string }>) {
  const server = createServer((req, res) => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const ref = /^as_(?:live|test)_([A-Za-z0-9]+)_/.exec(bearer)?.[1] ?? 'unknown';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        channel: { name: `chan-${ref}`, ref },
        account: owners[ref] ?? null,
        recipients: (PEOPLE[ref] ?? []).map((p) => ({
          key: p.key,
          name: p.name,
          handle: p.name,
          is_agent: false,
          reachable: true,
          last_seen: new Date().toISOString(),
        })),
        messages: [],
      }),
    );
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function dashboard(api: string, keys: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-people-'));
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-people-state-'));
  mkdirSync(join(state, 'previous'), { recursive: true });

  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ base_url: api, handle: 'now', key: 'u_now', credential: 'c', api_key: keys[0] }),
  );
  keys.slice(1).forEach((key, i) => {
    writeFileSync(
      join(state, 'previous', `u_past${i}.json`),
      JSON.stringify({
        base_url: api,
        handle: `past${i}`,
        key: `u_past${i}`,
        credential: 'c',
        api_key: key,
      }),
    );
  });

  const child = spawn(process.execPath, [VIEWER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      PORT: '0',
      AGENTSIGNAL_BASE_URL: api,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      AGENTSIGNAL_STATE_DIR: state,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const printed = await new Promise<string | null>((done) => {
    const timer = setTimeout(() => done(null), 15_000);
    const look = (chunk: Buffer) => {
      out += chunk;
      const match = /Watching \S+ on (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f-]{36})/.exec(out);
      if (match && /Loopback only/.test(out)) {
        clearTimeout(timer);
        done(match[1] ?? null);
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
  });
  expect(printed, `dashboard never started: ${out}`).toBeTruthy();

  const url = new URL(printed!);
  const origin = `http://127.0.0.1:${url.port}`;
  const first = await fetch(printed!);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
  const get = async (path: string) =>
    (await (await fetch(`${origin}${path}`, { headers: { Cookie: cookie } })).json()) as never;
  const bind = async (account: string) =>
    (await (
      await fetch(`${origin}/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
        body: JSON.stringify({ account }),
      })
    ).json()) as { ok?: boolean; error?: string };
  return { get, bind };
}

/*
  ORDER MATTERS. Company Two's key is FIRST, so it is the one channels[0] picks
  and the one the old default reached for. Binding to Company One then proves
  the fix rather than the fixture: get it wrong and the leak is Company Two,
  which is exactly what a real machine showed.
*/
const TWO_FIRST = [
  'as_test_chanbbbb_keytwotwotwotwotwotwotwo01',
  'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
];

type Setup = {
  channel: { ref?: string; name?: string } | null;
  reachable: { key: string; name: string }[];
};

describe('a dashboard shows one company\'s people', () => {
  it('asks with the BOUND company\'s key, not the first one the machine found', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, TWO_FIRST);

    expect((await v.bind(ONE.id)).ok).toBe(true);

    const setup = (await v.get('/setup')) as Setup;

    expect(setup.channel?.ref, 'the channel is the bound company\'s').toBe('chanaaaa');
    expect(setup.reachable.map((r) => r.key)).toEqual(['u_alice']);
    // Named, so a regression says whose data escaped rather than "length 1".
    expect(JSON.stringify(setup)).not.toContain('bob@company-two.example');
    expect(JSON.stringify(setup)).not.toContain('chanbbbb');
  }, 40_000);

  /**
   * The invite form posts `d.channel.ref` straight from this response, so a
   * wrong channel here is a join code minted into a company nobody chose.
   */
  it('never offers a channel belonging to the company this dashboard is not for', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, TWO_FIRST);

    expect((await v.bind(ONE.id)).ok).toBe(true);
    const setup = (await v.get('/setup')) as Setup;

    expect(setup.channel?.ref).not.toBe('chanbbbb');
  }, 40_000);

  /**
   * The same rule /messages keeps. Reading on is showing one company's people
   * behind a question about which company this is -- the mixture arriving a
   * second before the answer.
   */
  it('reads nobody at all while the company question is still open', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, TWO_FIRST);

    const setup = (await v.get('/setup')) as Setup;

    expect(setup.channel).toBeNull();
    expect(setup.reachable).toEqual([]);
    expect(JSON.stringify(setup)).not.toContain('@company-one.example');
    expect(JSON.stringify(setup)).not.toContain('@company-two.example');
  }, 40_000);

  /**
   * The checklist reads the roster too, and reported the other company's counts
   * -- "3 reachable" about people this dashboard is not for -- on the page that
   * claims to describe this machine.
   */
  it('counts the bound company\'s people in the setup checklist, and nobody else\'s', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, TWO_FIRST);

    const open = (await v.get('/onboarding')) as { steps: { id: string; detail: string }[] };
    const reachWhileOpen = open.steps.find((x) => x.id === 'reach');
    expect(reachWhileOpen?.detail, 'nothing is read while the question is open').toBe(
      'nobody else in this channel yet',
    );

    expect((await v.bind(ONE.id)).ok).toBe(true);

    const bound = (await v.get('/onboarding')) as { steps: { id: string; detail: string }[] };
    // Company One has exactly one person; Company Two also has one, so a count
    // alone could not tell them apart -- bind to ONE and assert it is ONE's.
    expect(bound.steps.find((x) => x.id === 'reach')?.detail).toBe('1 reachable');
    expect(JSON.stringify(bound)).not.toContain('@company-two.example');
  }, 40_000);

  /** One company is not a question, here either -- it binds and answers. */
  it('still answers immediately when every key is the same company', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: ONE });
    const v = await dashboard(api, TWO_FIRST);

    const setup = (await v.get('/setup')) as Setup;

    expect(setup.channel).not.toBeNull();
    expect(setup.reachable.length).toBeGreaterThan(0);
  }, 40_000);
});
