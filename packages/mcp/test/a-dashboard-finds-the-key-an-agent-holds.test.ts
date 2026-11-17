import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The dashboard finds the key the agent on this machine already holds.
 *
 * IT USED TO REFUSE TO START. Discovery read two places -- the environment and
 * an `mcpServers` entry in `~/.claude.json` -- and a web join writes the key to
 * neither. It writes it beside the credential in `agent.json`, which the dashboard
 * already opens, for the handle and the repo, and then walked past the one
 * field it needed. So the ordinary setup was: connect an agent from the
 * dashboard, watch it get a key, and be told `AGENTSIGNAL_API_KEY is not set`.
 *
 * The failure it produced was worse than the message: the advice is to export a
 * key, one export holds one key, and a key names ONE channel -- so anybody
 * following it ends up exporting per shell, per channel, by hand. The fix
 * deletes that whole errand rather than documenting it.
 *
 * What has to hold, and is asserted below:
 *
 *   • a key in `agent.json` is enough to start, with nothing in the environment
 *   • that key is the one actually sent upstream, not merely accepted at startup
 *   • where it came from is SAID -- a dashboard that goes looking for credentials
 *     silently is indistinguishable from one that steals them
 *   • with nothing anywhere it still refuses, and names all three places, since
 *     a message naming two of three sends people to configure the wrong one
 *   • a key kept as a reference resolves out of the keychain (macOS only, and
 *     skipped rather than faked, because faking it would assert nothing)
 */

const VIEWER = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/dashboard.mjs',
);

const KEY = 'as_test_test0001_000000000000000000000000';

const running: ChildProcess[] = [];
const servers: Server[] = [];
const keychainItems: string[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)));
  for (const account of keychainItems.splice(0)) {
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', 'agentsignal', '-a', account], {
        stdio: 'ignore',
      });
    } catch {
      /* never created, or already gone */
    }
  }
});

/** A stand-in AgentSignal that remembers what it was authorised with. */
async function fakeApi() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        channel: { name: 'Test', ref: 'test0001', is_sandbox: true },
        recipients: [],
        messages: [],
      }),
    );
  });

  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/**
 * Start the dashboard with NOTHING in the environment but a base URL and a state
 * directory, which is the situation this is all about.
 */
function start(api: string, identity: Record<string, unknown>, homeOverride?: string) {
  const home = homeOverride ?? mkdtempSync(join(tmpdir(), 'agentsignal-holds-'));
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-holds-state-'));
  mkdirSync(state, { recursive: true });

  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ base_url: api, handle: 'planner', key: 'u_planner', credential: 'i.s', ...identity }),
  );

  const child = spawn(process.execPath, [VIEWER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      PORT: '0',
      AGENTSIGNAL_BASE_URL: api,
      // Passed through so a spawned server obeys the same keychain switch as the
      // runner. Empty means "not set", which is what an ordinary run looks like.
      AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
      AGENTSIGNAL_STATE_DIR: state,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const settled = new Promise<{ url: string | null; out: string; code: number | null }>(
    (resolveIt) => {
      const timer = setTimeout(() => resolveIt({ url: null, out, code: null }), 12_000);
      const look = (chunk: Buffer) => {
        out += chunk;
        const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f-]{36})/.exec(out);
        if (match && /Loopback only/.test(out)) {
          clearTimeout(timer);
          resolveIt({ url: match[0], out, code: null });
        }
      };
      child.stdout?.on('data', look);
      child.stderr?.on('data', look);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolveIt({ url: null, out, code });
      });
    },
  );

  return { settled, state };
}

/** Whether ~/.claude.json holds a key the dashboard would reach for first. */
function borrowable(home: string): boolean {
  try {
    const raw = readFileSync(join(home, '.claude.json'), 'utf8');
    const found: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
        if (name === 'mcpServers' && value && typeof value === 'object') {
          for (const server of Object.values(value as Record<string, never>)) {
            const argv = ((server as { args?: string[] })?.args ?? []).join(' ');
            const key = (server as { env?: Record<string, string> })?.env?.AGENTSIGNAL_API_KEY;
            if (argv.includes('agentsignalnet/mcp') && key) found.push(key);
          }
        } else walk(value);
      }
    };
    walk(JSON.parse(raw));
    return found.length > 0;
  } catch {
    return false;
  }
}

describe('several servers are several channels', () => {
  /**
   * IT USED TO EXIT HERE.
   *
   * Two AgentSignal MCP servers each holding a key made the dashboard print
   * "they may be different accounts, so set AGENTSIGNAL_API_KEY to say which"
   * and stop. The reasoning was sound while the alternative was picking one
   * silently: showing somebody else's conversation is worse than showing
   * none. It stopped being sound once the rail could list channels, because
   * then nothing has to choose -- both are offered and named, and the reader
   * clicks.
   *
   * Asserted on STARTING, not on the wording, because the failure this
   * replaces was a process that exited before serving anything.
   */
  it('offers both instead of refusing to start', async () => {
    const api = await fakeApi();
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-two-servers-'));
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'agentsignal-one': {
            args: ['-y', '@agentsignalnet/mcp'],
            env: { AGENTSIGNAL_API_KEY: 'as_test_chanaaaa_keyforthefirstchannel001', AGENTSIGNAL_BASE_URL: api.url },
          },
          'agentsignal-two': {
            args: ['-y', '@agentsignalnet/mcp'],
            env: { AGENTSIGNAL_API_KEY: 'as_test_chanbbbb_keyforthesecondchannel01', AGENTSIGNAL_BASE_URL: api.url },
          },
        },
      }),
    );

    // No identity of its own: the keys have to come from the config, which is
    // the path that used to refuse.
    const state = mkdtempSync(join(tmpdir(), 'agentsignal-two-state-'));
    const child = spawn(process.execPath, [VIEWER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        PORT: '0',
        AGENTSIGNAL_NO_KEYCHAIN: '1',
        AGENTSIGNAL_STATE_DIR: state,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(child);

    let out = '';
    const started = await new Promise<{ url: string | null; out: string }>((done) => {
      const timer = setTimeout(() => done({ url: null, out }), 12_000);
      const look = (chunk: Buffer) => {
        out += chunk;
        const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f-]{36})/.exec(out);
        if (match && /Loopback only/.test(out)) {
          clearTimeout(timer);
          done({ url: match[0], out });
        }
      };
      child.stdout?.on('data', look);
      child.stderr?.on('data', look);
      child.on('exit', () => {
        clearTimeout(timer);
        done({ url: null, out });
      });
    });

    expect(started.url, `dashboard refused to start: ${started.out}`).toBeTruthy();
    // Both channels, named by the refs that are inside the keys.
    expect(started.out).toContain('chanaaaa');
    expect(started.out).toContain('chanbbbb');
    // And it says where each came from, which is the promise this file exists
    // to keep: a dashboard that finds credentials silently reads as one that
    // takes them.
    expect(started.out).toContain('.claude.json');
  }, 60_000);
});

describe('a dashboard finds the key an agent holds', () => {
  it('starts on a key in agent.json with nothing in the environment', async () => {
    const api = await fakeApi();
    const { settled } = start(api.url, { api_key: KEY });
    const started = await settled;

    expect(started.url, `dashboard never started: ${started.out}`).toBeTruthy();

    // Accepting a key at startup is not the same as using it. Ask for
    // something that goes upstream and read what the far end was handed.
    const url = new URL(started.url!);
    await fetch(`http://127.0.0.1:${url.port}/agents?t=${url.searchParams.get('t')}`);
    expect(api.seen).toContain(`Bearer ${KEY}`);
  });

  it('says whose key it took and where from', async () => {
    const api = await fakeApi();
    const { settled, state } = start(api.url, { api_key: KEY });
    const started = await settled;

    expect(started.out).toContain('planner');
    expect(started.out).toContain(join(state, 'agent.json'));
    // Never the key itself. Announcing the source must not become announcing
    // the secret, and this is the assertion that keeps it that way.
    expect(started.out).not.toContain(KEY);
  });

  it('still refuses with nothing anywhere, and names all three places', async () => {
    const api = await fakeApi();
    const { settled } = start(api.url, {});
    const started = await settled;

    expect(started.url).toBeNull();
    expect(started.code).toBe(1);
    expect(started.out).toContain('AGENTSIGNAL_API_KEY is not set');
    expect(started.out).toContain('~/.claude.json');
    expect(started.out).toContain('no agent on this machine holds one of its own');
  });

  // AGENTSIGNAL_NO_KEYCHAIN is honoured here too, and this is the only test in
  // the package that reaches a real keychain rather than an injected fake. It
  // writes into the developer's login keychain, which on macOS is a GUI prompt
  // -- so the switch that keeps the rest of the suite off it has to be able to
  // skip this as well, or "stop prompting" would still leave one.
  it.skipIf(
    process.platform !== 'darwin' ||
      !existsSync('/usr/bin/security') ||
      Boolean(process.env.AGENTSIGNAL_NO_KEYCHAIN),
  )(
    'resolves a key kept as a reference out of the keychain',
    async (context) => {
      // THE REAL HOME, uniquely in this file. `security` finds the login
      // keychain through $HOME, so a temp one has no keychain to search and
      // the lookup fails for a reason that has nothing to do with what is
      // being tested. The state directory stays isolated, which is what
      // actually matters -- the dashboard must not see the developer's agents.
      const home = process.env.HOME ?? homedir();

      // Discovery stops at the first source that answers, and with a real home
      // an `mcpServers` key would answer BEFORE agent.json -- making this test
      // assert nothing while still passing. Skip rather than pretend.
      if (borrowable(home)) context.skip();

      const account = `u_dashboard_test_${process.pid}`;
      keychainItems.push(account);
      execFileSync(
        '/usr/bin/security',
        ['add-generic-password', '-s', 'agentsignal', '-a', account, '-U', '-T', '/usr/bin/security', '-w'],
        { input: `${KEY}\n${KEY}\n`, stdio: ['pipe', 'ignore', 'ignore'] },
      );

      const api = await fakeApi();
      const { settled } = start(api.url, { api_key_ref: `keychain://agentsignal/${account}` }, home);
      const started = await settled;

      expect(started.url, `dashboard never started: ${started.out}`).toBeTruthy();

      const url = new URL(started.url!);
      await fetch(`http://127.0.0.1:${url.port}/agents?t=${url.searchParams.get('t')}`);
      expect(api.seen).toContain(`Bearer ${KEY}`);
      // The reference is a location and safe to print; the value is not.
      expect(started.out).toContain(`keychain://agentsignal/${account}`);
      expect(started.out).not.toContain(KEY);
    },
  );

  it('reads a stored identity without needing the file to change', async () => {
    // Guards the shape rather than the behaviour: `identities()` is what the
    // daemon and the hooks read too, and a field added for the dashboard alone
    // would be the fourth copy of this logic drifting from the others.
    const api = await fakeApi();
    const { settled, state } = start(api.url, { api_key: KEY });
    await settled;

    const onDisk = JSON.parse(readFileSync(join(state, 'agent.json'), 'utf8'));
    // The dashboard BORROWS. Moving or rewriting somebody else's credential is
    // the MCP server's job, and a dashboard that mutated it would race it.
    expect(onDisk.api_key).toBe(KEY);
  });
});

/**
 * AN INVITATION IS SIGNED BY A MEMBER OF THE CHANNEL IT IS INTO.
 *
 * Minting is a membership right, not a key right: the code carries who
 * extended it, which is what fills in `sponsored_by` and lets a fleet work out
 * who leads. The API therefore refuses a code minted by anyone who is not in
 * that channel.
 *
 * The dashboard had ONE notion of "me" -- `resolveSelf()` runs once at startup
 * against the default channel -- and offered it as the inviter for every
 * channel in the rail. Correct for the first, refused for all the rest, with an
 * API message naming the CHANNEL, so it read as a missing permission rather
 * than as the wrong signature.
 *
 * And the identity that opens a second channel is often one this agent USED to
 * be: superseded, archived under `previous/`, still holding a credential. That
 * is how the channel is discovered in the first place, so a lookup over live
 * identities alone answered "connect this project first" about a project that
 * was already connected.
 */
describe('an invitation comes from a member of that channel', () => {
  const LIVE = 'as_test_chanaaaa_keyforthefirstchannel001';
  const PAST = 'as_test_chanbbbb_keyforthesecondchannel01';

  async function recordingApi() {
    const minted: { path: string; auth: string }[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.includes('/join-tokens')) {
        minted.push({ path: url, auth: req.headers.authorization ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        // Shaped like the real endpoint: the code is nested under `token`.
        res.end(
          JSON.stringify({
            ok: true,
            token: { token: 'as_join_chanbbbb_mintedbythefake', expires_at: '2026-01-01T00:00:00Z' },
          }),
        );
        return;
      }
      /*
        Answers about the channel it was ASKED with, by reading the ref out of
        the bearer key -- the same place the dashboard reads it from. A fake
        that returns one fixed ref for every key makes both channels collapse
        onto one entry, and then the invite is signed by whichever came first:
        the test passes or fails for a reason that has nothing to do with the
        code under it.
      */
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const ref = /^as_(?:live|test)_([A-Za-z0-9]+)_/.exec(bearer)?.[1] ?? 'test0001';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: { name: ref, ref }, recipients: [], messages: [] }));
    });
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, minted };
  }

  it('signs with the archived identity that holds the second channel', async () => {
    const api = await recordingApi();
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-invite-'));
    const state = mkdtempSync(join(tmpdir(), 'agentsignal-invite-state-'));
    mkdirSync(join(state, 'previous'), { recursive: true });

    // Live: in channel A. Archived: in channel B, and the only member of it
    // this machine has.
    writeFileSync(
      join(state, 'agent.json'),
      JSON.stringify({ base_url: api.url, handle: 'now', key: 'u_now', credential: 'live.cred', api_key: LIVE }),
    );
    writeFileSync(
      join(state, 'previous', 'u_then.json'),
      JSON.stringify({ base_url: api.url, handle: 'then', key: 'u_then', credential: 'past.cred', api_key: PAST }),
    );

    const child = spawn(process.execPath, [VIEWER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        PORT: '0',
        AGENTSIGNAL_BASE_URL: api.url,
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

    const at = new URL(printed!);
    const origin = `http://127.0.0.1:${at.port}`;
    const grant = await fetch(printed!);
    const cookie = (grant.headers.get('set-cookie') ?? '').split(';')[0]!;

    const response = await fetch(`${origin}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
      body: JSON.stringify({ channel: 'chanbbbb' }),
    });
    const body = (await response.json()) as { error?: string };

    expect(body.error, 'the second channel should be invitable').toBeUndefined();
    expect(api.minted.length).toBe(1);
    expect(api.minted[0]!.path).toContain('chanbbbb');
    // THE ASSERTION. Signed by the member of chanbbbb, which is the archived
    // identity -- not by the live one, which is a member of chanaaaa only.
    expect(api.minted[0]!.auth).toBe('Device past.cred');
  }, 60_000);
});
