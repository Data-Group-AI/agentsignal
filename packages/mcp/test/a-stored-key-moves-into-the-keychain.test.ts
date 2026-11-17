import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A key already written in plaintext moves, the first time it is read.
 *
 * The change that put an agent's key in the keychain would otherwise be worth
 * nothing to the agents that already have one -- they were minted a key before
 * it existed, and it is sitting in `agent.json` where it always was. Nobody is
 * going to be told to go and move it, so the read path moves it: the value is
 * in hand, it can be proved to come back out, and that is the only moment the
 * migration is free.
 *
 * WHAT MUST HOLD, and the reason each one is here rather than assumed:
 *
 *   • the plaintext is GONE afterwards, not merely duplicated. Two copies of
 *     one credential is one copy nobody remembers to revoke, and a migration
 *     that leaves the original behind has moved nothing.
 *   • the agent still has its key. A migration that loses it breaks the agent
 *     at the next start rather than now, which is the failure mode worth
 *     paying a test for -- so the keyed tier is asserted to be ON.
 *   • it writes back to the file it READ, not to wherever a fresh identity
 *     would go, or an identity in one directory quietly becomes two.
 *
 * macOS only, and skipped rather than faked elsewhere: the fallback path -- no
 * keychain, keep the plaintext -- is unit-tested against an injected runner in
 * `a-key-in-the-keychain-not-the-file.test.ts`, where it can be made to fail on
 * demand. What cannot be faked usefully is the real `security`, which is the
 * half that decides whether this works on the machine it ships to.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const KEY = 'as_live_abcd1234_secretsecretsecretsecre';

const running: ChildProcess[] = [];
const keychainItems: string[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const account of keychainItems.splice(0)) {
    try {
      execFileSync(
        '/usr/bin/security',
        ['delete-generic-password', '-s', 'agentsignal', '-a', account],
        { stdio: 'ignore' },
      );
    } catch {
      /* never created, or already gone */
    }
  }
});

/** Start the server on a given state directory and list its tools once it is up. */
function toolsOf(state: string): Promise<string[]> {
  return new Promise((resolveIt, reject) => {
    const child = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        // The real home, because `security` finds the login keychain through
        // it. The state directory is still a temporary one, which is what
        // keeps the developer's own agents out of this.
        HOME: process.env.HOME ?? homedir(),
        AGENTSIGNAL_BASE_URL: 'http://127.0.0.1:1',
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: state,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    running.push(child);

    let buffer = '';
    const timer = setTimeout(() => reject(new Error('no response')), 45_000);
    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        let message: { id?: unknown; result?: { tools?: { name: string }[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          continue;
        }
        if (message.id === 2 && message.result?.tools) {
          clearTimeout(timer);
          resolveIt(message.result.tools.map((tool) => tool.name));
        }
      }
    });

    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
  });
}

// The whole file is about a REAL keychain -- that is what makes it worth having
// beside the injected-runner unit tests -- so the switch that keeps the suite
// off a developer's login keychain has to skip it rather than watch it fail.
describe.skipIf(
  process.platform !== 'darwin' ||
    !existsSync('/usr/bin/security') ||
    Boolean(process.env.AGENTSIGNAL_NO_KEYCHAIN),
)(
  'a key stored in plaintext moves into the keychain',
  () => {
    it('drops the plaintext, keeps the key, and writes back where it read', async () => {
      const account = `u_migrate_test_${process.pid}`;
      keychainItems.push(account);

      const state = mkdtempSync(join(tmpdir(), 'agentsignal-migrate-'));
      const file = join(state, 'agent.json');
      writeFileSync(
        file,
        JSON.stringify({
          base_url: 'http://127.0.0.1:1',
          handle: 'planner',
          key: account,
          credential: 'install.secret',
          api_key: KEY,
        }),
      );

      const tools = await toolsOf(state);

      // The key survived the move: keyed tools need a client, and a client
      // needs the key that was just relocated.
      expect(tools).toContain('list_people');

      const onDisk = JSON.parse(readFileSync(file, 'utf8'));
      expect(onDisk.api_key_ref).toBe(`keychain://agentsignal/${account}`);
      // The point of the whole exercise.
      expect(onDisk.api_key).toBeUndefined();
      // Untouched by the rewrite. A migration that drops the device credential
      // would unregister the agent while looking like it tidied up.
      expect(onDisk.credential).toBe('install.secret');
      expect(onDisk.handle).toBe('planner');

      // And the value really is in the keychain, not merely claimed to be.
      const held = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'agentsignal', '-a', account, '-w'],
        { encoding: 'utf8' },
      ).trim();
      expect(held).toBe(KEY);
    }, 60_000);

    it('starts from a reference alone, with no plaintext to fall back to', async () => {
      const account = `u_ref_only_test_${process.pid}`;
      keychainItems.push(account);
      execFileSync(
        '/usr/bin/security',
        ['add-generic-password', '-s', 'agentsignal', '-a', account, '-U', '-T', '/usr/bin/security', '-w'],
        { input: `${KEY}\n${KEY}\n`, stdio: ['pipe', 'ignore', 'ignore'] },
      );

      const state = mkdtempSync(join(tmpdir(), 'agentsignal-refonly-'));
      writeFileSync(
        join(state, 'agent.json'),
        JSON.stringify({
          base_url: 'http://127.0.0.1:1',
          handle: 'planner',
          key: account,
          credential: 'install.secret',
          api_key_ref: `keychain://agentsignal/${account}`,
        }),
      );

      expect(await toolsOf(state)).toContain('list_people');
    }, 60_000);
  },
);
