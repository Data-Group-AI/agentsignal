import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A dashboard is for ONE company.
 *
 * A machine accumulates keys -- environment, MCP config, the identity it holds
 * now, and every identity it used to hold -- and nothing required those to
 * belong to the same company. So one window could show two companies side by
 * side: two rule sets, two billing accounts, two sets of people, one
 * credential-holder straddling them, and no single answer to "whose rules apply
 * to this work".
 *
 * It was not hypothetical. The machine this was written on held keys to two,
 * and both of them had a channel called "Sandbox" -- so the rail offered two
 * identically named conversations belonging to different companies.
 *
 * The rule: the scope is chosen once, named at the top, and everything else is
 * listed but inert. Not hidden -- a channel that vanishes is a channel somebody
 * hunts for -- and not openable, which is the whole point.
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

/** Answers about whichever channel the key names, with the account that owns it. */
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
        recipients: [],
        /*
          A ROW, deliberately. With an empty log "read nothing" and "read an
          empty channel" look identical, and the assertion below would pass
          against a dashboard that polls before the company is chosen -- which
          is the thing it exists to forbid.
        */
        messages: [
          {
            id: `m-${ref}`,
            title: 'a title',
            body: 'an ordinary body',
            from_handle: 'planner',
            to_handle: 'someone',
            created_at: new Date(Date.now() - 60_000).toISOString(),
            encrypted: false,
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function dashboard(api: string, keys: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-scope-'));
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-scope-state-'));
  mkdirSync(join(state, 'previous'), { recursive: true });

  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ base_url: api, handle: 'now', key: 'u_now', credential: 'c', api_key: keys[0] }),
  );
  keys.slice(1).forEach((key, i) => {
    writeFileSync(
      join(state, 'previous', `u_past${i}.json`),
      JSON.stringify({ base_url: api, handle: `past${i}`, key: `u_past${i}`, credential: 'c', api_key: key }),
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
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f-]{36})/.exec(out);
      if (match && /Loopback only/.test(out)) {
        clearTimeout(timer);
        done(match[0]);
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

const ONE = { id: 'acct-one', name: 'Company One' };
const TWO = { id: 'acct-two', name: 'Company Two' };

describe('a dashboard is for one company', () => {
  /**
   * The ordinary case must not grow a question. Most machines hold keys to one
   * company, and asking which of one is an obstacle rather than a safeguard.
   */
  it('binds without asking when every key is the same company', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: ONE });
    const v = await dashboard(api, [
      'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
      'as_test_chanbbbb_keytwotwotwotwotwotwotwo01',
    ]);

    const body = (await v.get('/messages')) as { bound: string; channels: { elsewhere: boolean }[] };
    expect(body.bound).toBe('acct-one');
    expect(body.channels.every((c) => !c.elsewhere)).toBe(true);
  }, 40_000);

  it('asks, and reads nothing at all, while two companies are unchosen', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, [
      'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
      'as_test_chanbbbb_keytwotwotwotwotwotwotwo01',
    ]);

    const body = (await v.get('/messages')) as {
      bound: string | null;
      companies: { account: string }[];
      messages: unknown[];
    };
    expect(body.bound).toBeNull();
    expect(body.companies.length).toBe(2);
    // THE ONE THAT MATTERS. Showing one company's conversation behind a
    // question about which company this is would be the mixing this prevents,
    // arriving a second before the answer -- and billing the wrong account for
    // the privilege, since a log read that returns rows is charged.
    expect(body.messages.length).toBe(0);
  }, 40_000);

  it('keeps the other company listed, and refuses to open it', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, [
      'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
      'as_test_chanbbbb_keytwotwotwotwotwotwotwo01',
    ]);
    await v.get('/messages');
    expect((await v.bind('acct-one')).ok).toBe(true);

    const body = (await v.get('/messages')) as {
      bound: string;
      channels: { ref: string; company: string; elsewhere: boolean }[];
    };
    expect(body.bound).toBe('acct-one');

    // Listed, not dropped: knowing it exists is the point.
    const other = body.channels.find((c) => c.ref === 'chanbbbb')!;
    expect(other, 'the other company must still be visible').toBeTruthy();
    expect(other.elsewhere).toBe(true);
    expect(other.company).toBe('Company Two');

    // And refused, by name, rather than quietly showing something else -- a
    // redirect here would put another company's conversation under the name
    // that was asked for.
    const refused = (await v.get('/messages?channel=chanbbbb')) as {
      error?: string;
      messages: unknown[];
    };
    expect(refused.error).toMatch(/Company Two/);
    expect(refused.error).toMatch(/Company One/);
    expect(refused.messages.length).toBe(0);
  }, 40_000);

  it('will not switch companies once bound', async () => {
    const api = await fakeApi({ chanaaaa: ONE, chanbbbb: TWO });
    const v = await dashboard(api, [
      'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
      'as_test_chanbbbb_keytwotwotwotwotwotwotwo01',
    ]);
    await v.get('/messages');
    await v.bind('acct-one');

    // Rebinding would leave rows on screen that were read under the previous
    // scope, which is the mixture in slow motion.
    const again = await v.bind('acct-two');
    expect(again.error).toMatch(/already for Company One/i);
  }, 40_000);
});
