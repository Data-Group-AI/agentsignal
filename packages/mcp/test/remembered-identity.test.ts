import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * That an agent survives a restart without spending a join token.
 *
 * This is the whole reason the state file exists. `join_channel` used to hand
 * the credential to the model and tell it to set AGENTSIGNAL_DEVICE_SECRET --
 * advice a model inside a plugin cannot take, because it cannot edit the
 * config it was started from. So every restart rejoined, and rejoining is not
 * free: `redeem` increments `uses` before it reaches the idempotent agent
 * upsert, and a token minted without `max_uses` is good for exactly one. The
 * second start of a healthy agent got `exhausted` and stayed locked out.
 *
 * The assertions worth having are therefore about what does NOT happen: a
 * second start that does not call /v1/agents/register at all.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const JOIN = { AGENTSIGNAL_JOIN_TOKEN: 'as_join_test0001_abcdefghijklmnopqrstuvwxyz01' };

const REGISTRATION = {
  agent: { handle: 'rerank-bot', key: 'u_8fk2AbCdEfGhIjKlMnOpQr', id: 'a-1' },
  device_secret: '11111111-2222-3333-4444-555555555555.' + 'ab'.repeat(32),
  created: true,
};

let http: Server;
let baseUrl: string;
let seen: string[] = [];
/** Set by the revocation test: the credential on disk is no longer good. */
let inboxRejects = false;
/** Set when a join should come back as a different recipient (another channel). */
let registrationKey: string | null = null;
/**
 * An API key for the registration to hand back, when a test needs the agent to
 * end up holding one.
 *
 * Most tests here do not care and leave it null. The re-paste guard does: it
 * refuses only when the agent is in the channel AND holds that channel's key,
 * so staging that case means the join has to actually leave a key behind.
 */
let registrationApiKey: string | null = null;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push(`${req.method} ${path}`);
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        res.statusCode = 200;
        // A join into a DIFFERENT channel comes back as a different
        // recipient, because recipients are scoped to their project. That is
        // the whole reason an identity gets displaced, so the mock has to be
        // able to say it.
        res.end(
          JSON.stringify(
            {
              ...REGISTRATION,
              ...(registrationKey
                ? { agent: { ...REGISTRATION.agent, key: registrationKey } }
                : {}),
              ...(registrationApiKey ? { api_key: registrationApiKey } : {}),
            },
          ),
        );
        return;
      }

      // WHICH CHANNELS THIS AGENT IS IN. `join_channel` asks before deciding
      // whether an explicitly-passed code is a no-op, so without this the
      // guard cannot tell a re-paste from a new invitation.
      if (path.startsWith('/v1/channels')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            channels: [
              {
                ref: 'test0001',
                name: 'Fleet',
                slug: 'fleet',
                is_home: true,
                is_sandbox: false,
                mine: false,
                members: 1,
              },
            ],
          }),
        );
        return;
      }

      if (path.startsWith('/v1/devices/me/messages')) {
        // Whether this is reached at all is the point: it needs a credential,
        // and in the restart tests nothing put one in the environment.
        if (inboxRejects) {
          res.statusCode = 401;
          res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Provide a device credential as `Authorization: Device <install_id>.<secret>`.',
              },
            }),
          );
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ messages: [] }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: path } }));
    });
  });

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((r) => http.close(() => r())));

beforeEach(() => {
  seen = [];
  inboxRejects = false;
  registrationKey = null;
  registrationApiKey = null;
});

/**
 * Two tool calls down one server process.
 *
 * The recovery below only means anything in a single process: the flag that
 * lets `join_channel` past its guard is set by the failure, so a test that
 * spawned twice would be testing nothing.
 */
function callTwo(
  calls: { name: string; args: Record<string, unknown> }[],
  stateDir: string,
  env: Record<string, string> = {},
): Promise<{ text: string; isError: boolean }[]> {
  return new Promise((resolveCalls, reject) => {
    const child: ChildProcess = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: stateDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const results: { text: string; isError: boolean }[] = [];
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('no response'));
    }, 45_000);

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      // Drain whole lines and keep the partial one. The single-call harnesses
      // elsewhere re-scan the whole buffer and stop at the first match, which
      // is fine when there is only ever one reply to wait for and silently
      // loses the second when there are two.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;

        let message: { id?: unknown; result?: { content?: { text?: string }[]; isError?: boolean } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (typeof message.id !== 'number' || message.id < 10) continue;

        const content = message.result?.content ?? [];
        results[message.id - 10] = {
          text: content.map((c) => c.text ?? '').join('\n'),
          isError: Boolean(message.result?.isError),
        };

        const done = results.filter(Boolean).length;
        if (done === calls.length) {
          clearTimeout(timer);
          child.kill();
          resolveCalls(results);
          return;
        }

        // One at a time. Sent together they race, and the whole point here is
        // that the second call happens after the first has failed.
        send(done);
      }
    });

    child.on('error', reject);

    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');

    function send(i: number) {
      say({
        jsonrpc: '2.0',
        id: 10 + i,
        method: 'tools/call',
        params: { name: calls[i]!.name, arguments: calls[i]!.args },
      });
    }

    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'identity-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send(0);
  });
}

/** One server process, one tool call, in a state directory the caller owns. */
function callTool(
  name: string,
  args: Record<string, unknown>,
  stateDir: string,
  env: Record<string, string> = {},
): Promise<{ text: string; isError: boolean; tools: string[] }> {
  return new Promise((resolveCall, reject) => {
    const child: ChildProcess = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: stateDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let tools: string[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no response from ${name}`));
    }, 45_000);

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            tools = (message.result?.tools ?? []).map((t: { name: string }) => t.name);
            continue;
          }
          if (message.id !== 3) continue;
          clearTimeout(timer);
          child.kill();
          const content = message.result?.content ?? [];
          resolveCall({
            text: content.map((c: { text?: string }) => c.text ?? '').join('\n'),
            isError: Boolean(message.result?.isError),
            tools,
          });
          return;
        } catch {
          // Partial line.
        }
      }
    });

    child.on('error', reject);

    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');
    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'identity-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

const fresh = () => mkdtempSync(join(tmpdir(), 'agentsignal-identity-'));

/**
 * The credential, wherever under the state directory it was written.
 *
 * NOT a fixed `agent.json` any more. An identity is per-checkout now, so a
 * session inside a repository writes to `agents/<checkout>.json` and only one
 * outside a repository uses the shared file. These tests run inside this
 * repository, so they get the former -- and hard-coding either path would
 * assert the layout rather than the behaviour, which is that the secret ends
 * up on disk instead of in the transcript.
 */
function storedCredential(state: string): Record<string, string> {
  const candidates = [
    join(state, 'agent.json'),
    // One directory per checkout, each holding its own `agent.json` -- the
    // same shape the watcher and the hooks already know how to read.
    ...(existsSync(join(state, 'agents'))
      ? readdirSync(join(state, 'agents')).map((d) => join(state, 'agents', d, 'agent.json'))
      : []),
  ].filter((f) => existsSync(f));
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one stored credential, found ${candidates.length}`);
  }
  return JSON.parse(readFileSync(candidates[0]!, 'utf8'));
}

describe('joining, once', () => {
  it('writes the credential down instead of reading it out', async () => {
    const state = fresh();
    const { text, isError } = await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    expect(isError).toBe(false);
    expect(text).toContain('u_8fk2AbCdEfGhIjKlMnOpQr');

    // A secret that has been written down does not need to be in a transcript.
    expect(text).not.toContain(REGISTRATION.device_secret);

    const stored = storedCredential(state);
    expect(stored.credential).toBe(REGISTRATION.device_secret);
    expect(stored.handle).toBe('rerank-bot');
    expect(stored.base_url).toBe(baseUrl);
  }, 60_000);

  it('is an agent on the next start with nothing in the environment', async () => {
    const state = fresh();
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    // No join token and no API key this time -- only what the last run left
    // behind, which is exactly a restarted plugin.
    seen = [];
    const { isError, tools } = await callTool('read_inbox', {}, state);

    expect(isError).toBe(false);
    expect(tools).toContain('read_inbox');
    expect(tools).toContain('notify_as_self');
    expect(seen.some((r) => r.includes('/v1/devices/me/messages'))).toBe(true);
    expect(seen.some((r) => r.includes('/v1/agents/register'))).toBe(false);
  }, 60_000);

  it('refuses to redeem the token again for a handle it already is', async () => {
    const state = fresh();
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    seen = [];
    const { text, isError } = await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    expect(isError).toBe(false);
    expect(text).toContain('Already registered');
    // The assertion this file exists for.
    expect(seen.some((r) => r.includes('/v1/agents/register'))).toBe(false);
  }, 60_000);

  /**
   * THE HANDLE IS NOT THE WHOLE QUESTION.
   *
   * The guard above exists so a restart does not spend a token use. It used to
   * decide on the handle alone, which is right for a restart and wrong for
   * everything else: an agent already registered and handed a fresh code for
   * a DIFFERENT channel was told "nothing to do" and never joined it. So an
   * existing session could not be added to a second channel at all, and the
   * invitation looked from the outside like it had worked.
   *
   * These two are the halves that have to stay apart. Both pass an EXPLICIT
   * code, so neither is the restart case; the only thing separating them is
   * which channel the code admits to.
   */
  it('does not redeem a code for a channel it is already in, holding its key', async () => {
    const state = fresh();
    /**
     * HOLDING ITS KEY is half of the condition, and it has to be staged.
     *
     * Membership alone used to end the call here, which silently defeated the
     * whole point of a second invitation: a person-minted code delivers a key
     * on EVERY redemption, so re-inviting an agent is how you give it one. An
     * agent that is in the channel and holds nothing is the case somebody
     * mints that second code FOR, and it now redeems --
     * a-member-without-a-key-redeems.test.ts is that half.
     *
     * What is left here is the case the guard was written for: a working,
     * keyed agent being handed a code for the channel it already works in.
     * That must still cost the code nothing.
     */
    registrationApiKey = 'as_live_test0001_thekeyforthischannel00001';
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);
    registrationApiKey = null;

    seen = [];
    const { text, isError } = await callTool(
      'join_channel',
      // The same channel the mock says this agent is in.
      { handle: 'rerank-bot', token: 'as_join_test0001_zzzzzzzzzzzzzzzzzzzzzzzz' },
      state,
      JOIN,
    );

    expect(isError).toBe(false);
    expect(text).toContain('already in');
    // Said out loud, because a caller cannot otherwise tell an unspent code
    // from a spent one, and the code may be somebody else's only way in.
    expect(text).toContain('NOT spent');
    expect(seen.some((r) => r.includes('/v1/agents/register'))).toBe(false);
  }, 60_000);

  it('redeems a code for a channel it is not in yet', async () => {
    const state = fresh();
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    seen = [];
    const { isError } = await callTool(
      'join_channel',
      // A different channel. The mock lists only test0001.
      { handle: 'rerank-bot', token: 'as_join_othr0002_zzzzzzzzzzzzzzzzzzzzzzzz' },
      state,
      JOIN,
    );

    expect(isError).toBe(false);
    // THE ASSERTION THIS PAIR EXISTS FOR. Refusing here is the bug: same
    // handle, same agent, somewhere it has never been.
    expect(seen.some((r) => r.includes('/v1/agents/register'))).toBe(true);
  }, 60_000);

  /**
   * JOINING A SECOND CHANNEL MUST NOT SILENTLY UNMAKE THE FIRST.
   *
   * A recipient is scoped to its project, so a code for another channel mints
   * a NEW key rather than widening the existing agent. The credential file is
   * keyed by checkout, so the new identity lands on top of the old one -- and
   * this session stops being able to act as who it was. That was harmless
   * while join_channel refused a second channel outright. Fixing that refusal
   * is what made it reachable, so it is this change's to carry.
   *
   * Two things have to be true and neither is the other: the response has to
   * SAY so, and the displaced credential has to still exist.
   */
  it('says so when joining somewhere new replaces the identity', async () => {
    const state = fresh();
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    registrationKey = 'u_secondChannelAbCdEfGh';
    const { text, isError } = await callTool(
      'join_channel',
      { handle: 'rerank-bot', token: 'as_join_othr0002_zzzzzzzzzzzzzzzzzzzzzzzz' },
      state,
      JOIN,
    );
    registrationKey = null;

    expect(isError).toBe(false);
    // Named, not hinted at. "Registered" plus a new key reads as success.
    expect(text).toContain('THIS REPLACED');
    expect(text).toContain('u_8fk2AbCdEfGhIjKlMnOpQr');
    // And the way to actually be in both, since that is what was wanted.
    expect(text).toContain('add_agent_to_channel');
  }, 60_000);

  it('keeps the credential it displaced instead of overwriting it', async () => {
    const state = fresh();
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    registrationKey = 'u_secondChannelAbCdEfGh';
    await callTool(
      'join_channel',
      { handle: 'rerank-bot', token: 'as_join_othr0002_zzzzzzzzzzzzzzzzzzzzzzzz' },
      state,
      JOIN,
    );
    registrationKey = null;

    // The active identity is the new one.
    expect(storedCredential(state).key).toBe('u_secondChannelAbCdEfGh');

    // THE ASSERTION THIS EXISTS FOR. The old credential is still on disk, so
    // switching back is a decision rather than a re-invitation.
    const kept = readdirSync(join(state, 'agents'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const vault = join(state, 'agents', entry.name, 'previous');
        return existsSync(vault)
          ? readdirSync(vault).map((file) => JSON.parse(readFileSync(join(vault, file), 'utf8')))
          : [];
      });

    expect(kept.map((one) => one.key)).toContain('u_8fk2AbCdEfGhIjKlMnOpQr');
    expect(kept[0].credential).toBe(REGISTRATION.device_secret);
  }, 60_000);

  it('tells a model that has one that it is already registered', async () => {
    const state = fresh();
    await callTool('join_channel', { handle: 'rerank-bot' }, state, JOIN);

    // Reached through tools/list, because the description is the only thing
    // steering a model away from a call that would spend a use.
    const child = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: state,
        ...JOIN,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const description = await new Promise<string>((resolveIt, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('no tools/list'));
      }, 45_000);
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (const line of buffer.split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          try {
            const message = JSON.parse(line);
            if (message.id !== 2 || !message.result?.tools) continue;
            clearTimeout(timer);
            child.kill();
            const tool = message.result.tools.find(
              (t: { name: string }) => t.name === 'join_channel',
            );
            resolveIt(tool?.description ?? '');
            return;
          } catch {
            // Partial line.
          }
        }
      });
      child.on('error', reject);
      const say = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
      say({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'identity-test', version: '1' },
        },
      });
      say({ jsonrpc: '2.0', method: 'notifications/initialized' });
      say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    });

    expect(description).toContain('ALREADY registered');
    expect(description).toContain('rerank-bot');
  }, 60_000);
});

describe('the other road in: register_self, with an API key', () => {
  const KEYED = { AGENTSIGNAL_API_KEY: 'as_live_test0001_abcdefghijklmnopqrstuvwxyz012345' };

  it('remembers the identity instead of telling the model to store it', async () => {
    const state = fresh();
    const { text, isError } = await callTool(
      'register_self',
      { handle: 'planner' },
      state,
      KEYED,
    );

    expect(isError).toBe(false);
    expect(text).not.toContain(REGISTRATION.device_secret);
    // The old text asked the model to do something it cannot do.
    expect(text).not.toContain('Store that secret now');

    expect(storedCredential(state).credential).toBe(REGISTRATION.device_secret);
  }, 60_000);

  it('turns an API key holder into an agent on the next start', async () => {
    const state = fresh();

    // Before: a key alone is not an agent, whatever it registered.
    const before = await callTool('register_self', { handle: 'planner' }, state, KEYED);
    expect(before.tools).not.toContain('read_inbox');

    // After: the remembered credential is there at startup, which is when the
    // agent tools are chosen.
    const after = await callTool('check_credit', {}, state, KEYED);
    expect(after.tools).toContain('read_inbox');
    expect(after.tools).toContain('notify_as_self');
  }, 60_000);
});

describe('a remembered credential that does not apply', () => {
  it('is ignored when it was saved against a different base URL', async () => {
    const state = fresh();
    writeFileSync(
      join(state, 'agent.json'),
      JSON.stringify({
        base_url: 'https://api.agentsignal.net',
        handle: 'rerank-bot',
        key: 'u_8fk2AbCdEfGhIjKlMnOpQr',
        credential: REGISTRATION.device_secret,
        saved_at: new Date().toISOString(),
      }),
    );

    // Pointed at the stub rather than production. Reusing a production
    // credential here is the mistake the base_url check exists to prevent --
    // the same shape as the warning about an agent under development paging
    // somebody real.
    const { tools } = await callTool('check_credit', {}, state);
    expect(tools).not.toContain('read_inbox');
    expect(tools).not.toContain('notify_as_self');
  }, 60_000);

  it('leaves no state file behind when there was nothing to remember', async () => {
    const state = fresh();
    await callTool('check_credit', {}, state);
    expect(existsSync(join(state, 'agent.json'))).toBe(false);
  }, 60_000);
});

/**
 * The credential written under one server name, read under another.
 *
 * CLAUDE_PLUGIN_DATA is named after the server that asked for it, so joining
 * through a hand-added `agentsignal-inline` and being read by the plugin's own
 * `agentsignal-agentsignal` are two different directories that are siblings.
 * The search used to be [own, ~/.agentsignal] and never looked sideways, so on
 * a second machine the identity sat on disk while the watcher logged
 * `No device credential ... Looked in:` and named two directories, neither of
 * them the one holding it. Three failed starts, no other symptom.
 *
 * This cannot use AGENTSIGNAL_STATE_DIR like the tests above -- that variable
 * is exclusive on purpose, and setting it is precisely what turns the sibling
 * search off. So the layout has to be built the way a real install has it, and
 * the variable explicitly cleared.
 */
describe('a credential a sibling server wrote', () => {
  /** A plugins/data root with the credential NOT in the server's own directory. */
  function siblingLayout(baseUrlForCredential: string) {
    const root = mkdtempSync(join(tmpdir(), 'agentsignal-siblings-'));
    const data = join(root, 'plugins', 'data');
    const own = join(data, 'agentsignal-agentsignal');
    const sibling = join(data, 'agentsignal-inline');
    mkdirSync(own, { recursive: true });
    mkdirSync(sibling, { recursive: true });

    writeFileSync(
      join(sibling, 'agent.json'),
      JSON.stringify({
        base_url: baseUrlForCredential,
        handle: 'rerank-bot',
        key: 'u_8fk2AbCdEfGhIjKlMnOpQr',
        credential: REGISTRATION.device_secret,
        saved_at: new Date().toISOString(),
      }),
    );

    return { own, sibling };
  }

  it('is found from the directory next to it', async () => {
    const { own } = siblingLayout(baseUrl);
    seen = [];

    // AGENTSIGNAL_STATE_DIR cleared, because callTool sets it and an explicit
    // directory switches off the very search under test.
    const { tools } = await callTool('check_credit', {}, own, {
      AGENTSIGNAL_STATE_DIR: '',
      CLAUDE_PLUGIN_DATA: own,
    });

    // The agent tools are the observable proof: they turn on only for a
    // process that resolved a device credential.
    expect(tools).toContain('read_inbox');
    // And it did NOT go get a new one. Re-registering would look like success
    // from the outside while spending a join token every start.
    expect(seen.filter((s) => s.includes('/v1/agents/register'))).toHaveLength(0);
  }, 60_000);

  it('still refuses one saved against a different base URL', async () => {
    const { own } = siblingLayout('https://api.agentsignal.net');

    // Widening the search must not widen what counts as a match. A production
    // credential in a neighbouring directory is exactly the thing that must
    // not be picked up by a server pointed somewhere else.
    const { tools } = await callTool('check_credit', {}, own, {
      AGENTSIGNAL_STATE_DIR: '',
      CLAUDE_PLUGIN_DATA: own,
    });

    expect(tools).not.toContain('read_inbox');
  }, 60_000);
});

describe('a remembered credential that has been revoked', () => {
  it('names the recovery, and lets the model take it', async () => {
    const state = fresh();
    writeFileSync(
      join(state, 'agent.json'),
      JSON.stringify({
        base_url: baseUrl,
        handle: 'rerank-bot',
        key: 'u_8fk2AbCdEfGhIjKlMnOpQr',
        credential: 'revoked.' + '00'.repeat(32),
        saved_at: new Date().toISOString(),
      }),
    );
    inboxRejects = true;
    seen = [];

    const results = await callTwo(
      [
        { name: 'read_inbox', args: {} },
        { name: 'join_channel', args: { handle: 'rerank-bot' } },
      ],
      state,
      JOIN,
    );
    const inbox = results[0]!;
    const rejoin = results[1]!;

    // A bare 401 would send a model looking for a missing header. This says
    // which credential died and what to do about it.
    expect(inbox.isError).toBe(true);
    expect(inbox.text).toContain('rerank-bot');
    expect(inbox.text).toContain('join_channel');

    // And the guard that normally refuses a redundant rejoin has stood down,
    // so the advice is advice the model can act on rather than a loop.
    expect(rejoin.isError).toBe(false);
    expect(seen.some((r) => r.includes('/v1/agents/register'))).toBe(true);

    // The fresh credential replaced the dead one on disk.
    expect(storedCredential(state).credential).toBe(REGISTRATION.device_secret);
  }, 60_000);
});

describe('an explicit credential', () => {
  it('outranks whatever was remembered', async () => {
    const state = fresh();
    writeFileSync(
      join(state, 'agent.json'),
      JSON.stringify({
        base_url: baseUrl,
        handle: 'stale-bot',
        key: 'u_staleAbCdEfGhIjKlMnOpQ',
        credential: 'dead.' + '00'.repeat(32),
        saved_at: new Date().toISOString(),
      }),
    );

    const { tools } = await callTool('check_credit', {}, state, {
      AGENTSIGNAL_DEVICE_SECRET: REGISTRATION.device_secret,
    });

    // Still an agent, but on the configured credential rather than the file.
    expect(tools).toContain('read_inbox');
  }, 60_000);
});
