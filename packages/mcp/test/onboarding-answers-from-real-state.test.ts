import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Onboarding answers from real state, and its limits are enforced.
 *
 * TWO FAILURES THIS EXISTS TO PREVENT, both of which this codebase has already
 * shipped in other places.
 *
 * The first is a checklist that stores its own progress. A "completed" flag is
 * a second copy of the truth, and the two drift in the direction that
 * flatters: the screen says configured, the machine is not, and nobody looks
 * again because the screen already said so. So every step here is DERIVED --
 * from the identities on disk, from the channel roster, from whether the
 * settings file exists -- and these tests change the world and assert the
 * derivation follows, rather than asserting a stored boolean.
 *
 * The second is a setting nothing reads. "At most N agents" that no code path
 * consults is the exact "column, not a feature" failure that shipped the
 * unprintable sponsorship field and the unrendered agent name: a value that is
 * real, stored, typed, and inert. The test that matters most in this file is
 * the one where the cap actually refuses a registration -- and proves nothing
 * was created upstream while doing it, because a limit that blocks the local
 * write after the remote create leaves an orphan account behind and is worse
 * than no limit at all.
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

/** A stand-in AgentSignal that REMEMBERS what it was asked to do. */
async function fakeApi(recipients: unknown[] = []) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST' && (req.url ?? '').startsWith('/v1/agents/register')) {
      res.end(
        JSON.stringify({
          ok: true,
          agent: { handle: 'made', key: 'u_made' },
          device_secret: 'made.secret',
        }),
      );
      return;
    }
    if ((req.url ?? '').startsWith('/v1/agents')) {
      res.end(
        JSON.stringify({
          ok: true,
          channel: { name: 'Test', ref: 'test0001', is_sandbox: true },
          recipients,
        }),
      );
      return;
    }
    res.end(JSON.stringify({ ok: true, messages: [] }));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    registered: () => seen.filter((s) => s.includes('/v1/agents/register')),
  };
}

/**
 * A directory that reads as a git checkout.
 *
 * An empty `.git` DIRECTORY is enough: repoRoot looks for the marker, and
 * treats a directory as the root itself rather than following a worktree
 * pointer. No git binary involved, so the test cannot fail on a machine's
 * git configuration.
 */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'agentsignal-project-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

async function dashboard(api: string, identities = 1) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-onboard-'));

  // WHERE THE PRODUCT ACTUALLY LOOKS, which is the whole point of not naming a
  // state directory here. An explicit AGENTSIGNAL_STATE_DIR is exclusive, so it
  // would hide the siblings these tests need -- but writing credentials
  // somewhere stateDirs() does not search is a fixture that reports zero
  // identities and passes every cap, which is how the first run of this file
  // "passed" the limit it was meant to prove.
  //
  // Siblings under plugins/data, one per server name, is the real shape: the
  // directory is named after whichever MCP server asked for it.
  const dataRoot = join(home, '.claude', 'plugins', 'data');
  for (let i = 0; i < identities; i++) {
    const dir = join(dataRoot, `agentsignal-${String.fromCharCode(97 + i)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        base_url: api,
        handle: i === 0 ? 'someone' : `other-${i}`,
        key: i === 0 ? 'u_someone' : `u_other${i}`,
        // Deduplication keys on the credential, so these must differ or two
        // directories count as one identity.
        credential: `install.${i}.secret`,
      }),
    );
  }

  const child = spawn(process.execPath, [VIEWER], {
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      AGENTSIGNAL_API_KEY: 'as_test_test0001_000000000000000000000000000000000',
      AGENTSIGNAL_BASE_URL: api,
      // Deliberately NOT set: an exclusive state dir would hide the sibling
      // identities this file needs, and the settings path is derived from HOME
      // either way.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const printed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard never printed a URL: ${out}`)), 15_000);
    const look = (chunk: Buffer) => {
      out += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f-]{36})/.exec(out);
      if (match && /Loopback only/.test(out)) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
  });

  const url = new URL(printed);
  return {
    home,
    port: url.port,
    token: url.searchParams.get('t')!,
    at(path: string) {
      return `http://127.0.0.1:${url.port}${path}${path.includes('?') ? '&' : '?'}t=${url.searchParams.get('t')}`;
    },
    settingsPath: join(home, '.agentsignal', 'settings.json'),
  };
}

const postJson = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('onboarding answers from real state', () => {
  it('needs the token, including to write settings', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);
    const bare = `http://127.0.0.1:${v.port}`;

    expect((await fetch(`${bare}/onboarding`)).status).toBe(404);
    // The write especially. This one puts a file on the machine.
    expect(
      (await fetch(`${bare}/onboarding`, postJson({ max_agents: 9, default_connection_type: 'partner' })))
        .status,
    ).toBe(404);
    expect(existsSync(v.settingsPath), 'a tokenless request wrote settings').toBe(false);
  }, 40_000);

  /**
   * The one setting here that spends money while nobody is watching, so it is
   * the one that must not move on its own -- in either direction.
   *
   * A first version of the save handler defaulted an omitted `responder` to
   * 'off', which reads as the safe choice and is not: somebody who turned
   * answering on, then later changed the agent cap from this same page, would
   * have had it silently switched off and no reason to suspect it. A setting
   * that turns itself off is exactly as untrustworthy as one that turns itself
   * on, because in both cases the machine is not doing what the person who
   * configured it believes.
   */
  it('leaves answering-while-away alone when a save does not mention it', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);

    const on = await fetch(
      v.at('/onboarding'),
      postJson({ max_agents: 4, default_connection_type: 'subagent', responder: 'answer' }),
    );
    expect(on.status).toBe(200);
    expect(JSON.parse(readFileSync(v.settingsPath, 'utf8')).responder).toBe('answer');

    // A save about something else entirely.
    const unrelated = await fetch(
      v.at('/onboarding'),
      postJson({ max_agents: 5, default_connection_type: 'subagent' }),
    );
    expect(unrelated.status).toBe(200);

    const after = JSON.parse(readFileSync(v.settingsPath, 'utf8'));
    expect(after.max_agents, 'the change it was asked to make').toBe(5);
    expect(after.responder, 'answering was switched off by a save about the cap').toBe('answer');
  }, 40_000);

  /** A value nobody can explain is worse than an error, so it is refused. */
  it('refuses a mode that is not one of the three', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);

    const bad = await fetch(
      v.at('/onboarding'),
      postJson({ max_agents: 4, default_connection_type: 'subagent', responder: 'sometimes' }),
    );
    expect(bad.status).toBe(400);
    expect(existsSync(v.settingsPath), 'a refused save wrote settings anyway').toBe(false);
  }, 40_000);

  it('reports a step undone until the world changes, not until a flag is set', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);

    const first = await (await fetch(v.at('/onboarding'))).json();
    const limits = (s: any) => s.steps.find((x: any) => x.id === 'limits');
    expect(limits(first).done, 'no settings file, yet it claims to be set up').toBe(false);

    const saved = await fetch(v.at('/onboarding'), postJson({ max_agents: 6, default_connection_type: 'worker' }));
    expect(saved.status).toBe(200);

    const second = await (await fetch(v.at('/onboarding'))).json();
    expect(limits(second).done).toBe(true);
    // Derived, so the detail reports what was actually stored rather than a
    // sentence written at the same time as the flag.
    expect(limits(second).detail).toContain('6');
    expect(limits(second).detail).toContain('worker');
    // Retention comes along even though this caller did not mention it: it is
    // optional in the payload and the stored value has to be complete, or the
    // next reader gets a file that is missing a field and has to guess.
    // Asserted exactly rather than partially, so a new setting cannot be added
    // without somebody deciding what it should be here.
    expect(JSON.parse(readFileSync(v.settingsPath, 'utf8'))).toEqual({
      max_agents: 6,
      default_connection_type: 'worker',
      history_days: 7,
      // Answering while away, carried through untouched by a caller that said
      // nothing about it. `off` was removed on 2026-08-21 and the floor is
      // `answer`, so this is no longer the assertion that somebody chose --
      // what it still forces is that a save about something ELSE cannot move
      // it. This is the one setting here that spends money unattended, and the
      // dangerous direction is now answer -> act rather than off -> on.
      responder: 'answer',
    });
  }, 40_000);

  it('refuses a cap that is already false, rather than clamping it', async () => {
    const api = await fakeApi();
    // Two identities on this machine, so a cap of one describes a machine that
    // does not exist.
    const v = await dashboard(api.url, 2);

    const attempt = await fetch(
      v.at('/onboarding'),
      postJson({ max_agents: 1, default_connection_type: 'partner' }),
    );
    expect(attempt.status).toBe(409);
    expect((await attempt.json()).error).toContain('already registered');

    // Refused means NOT WRITTEN. A clamped or partially-applied save would
    // leave a number nobody chose, which is the state everybody then plans
    // around.
    expect(existsSync(v.settingsPath), 'a refused save still wrote the file').toBe(false);
  }, 40_000);

  it('rejects a kind that is not one of the three', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);

    for (const bad of ['', 'admin', 'Partner', 'subagent ']) {
      const r = await fetch(v.at('/onboarding'), postJson({ max_agents: 4, default_connection_type: bad }));
      expect(r.status, `accepted ${JSON.stringify(bad)}`).toBe(400);
    }
    for (const bad of [0, -1, 65, 2.5, 'four']) {
      const r = await fetch(v.at('/onboarding'), postJson({ max_agents: bad, default_connection_type: 'partner' }));
      expect(r.status, `accepted ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(existsSync(v.settingsPath)).toBe(false);
  }, 60_000);

  /**
   * THE ONE THAT MATTERS. A limit that no code path consults is decoration.
   */
  it('enforces the cap when an agent would actually be created', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);
    const project = checkout();

    // One identity exists; cap it at one.
    expect(
      (await fetch(v.at('/onboarding'), postJson({ max_agents: 1, default_connection_type: 'subagent' })))
        .status,
    ).toBe(200);

    const blocked = await fetch(v.at('/connect'), postJson({ path: project, handle: 'over-the-line' }));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain('at most 1');

    // AND NOTHING WAS CREATED UPSTREAM. Checking the status alone would pass
    // for an implementation that registers the agent and then refuses to save
    // the credential -- which leaves an account somebody has to clean up by
    // hand, and no error anywhere saying so.
    expect(api.registered(), 'it registered an agent it then refused').toEqual([]);
  }, 40_000);

  it('lets the same registration through once the cap allows it', async () => {
    const api = await fakeApi();
    const v = await dashboard(api.url);
    const project = checkout();

    // Same request, same machine, only the limit differs -- so a pass here
    // says the cap was the reason for the refusal above, and not something
    // incidental about the path or the handle.
    expect(
      (await fetch(v.at('/onboarding'), postJson({ max_agents: 5, default_connection_type: 'subagent' })))
        .status,
    ).toBe(200);

    const allowed = await fetch(v.at('/connect'), postJson({ path: project, handle: 'within-the-line' }));
    expect(allowed.status, JSON.stringify(await allowed.clone().json())).toBe(200);
    expect(api.registered().length).toBe(1);
  }, 40_000);

  it('carries a name beside the handle, so a rename is visible', async () => {
    const api = await fakeApi([
      { key: 'u_jeff', handle: 'sparkgpt-dev', name: 'jeff', is_agent: true, reachable: true },
      { key: 'u_plain', handle: 'planner', name: 'planner', is_agent: true, reachable: true },
    ]);
    const v = await dashboard(api.url);

    // The page renders the pair; this asserts the field SURVIVES THE HOP that
    // dropped it. /setup used to send `handle: r.handle ?? r.key` and nothing
    // else, so no rendering could have shown a name however it was written --
    // the bug was a layer below the code everybody was reading.
    const setup = await (await fetch(v.at('/setup'))).json();
    const jeff = setup.reachable.find((r: any) => r.key === 'u_jeff');
    expect(jeff.name).toBe('jeff');
    expect(jeff.handle).toBe('sparkgpt-dev');
  }, 40_000);
});
