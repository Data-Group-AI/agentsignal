import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A configured join token is a capability, not permission to enroll.
 *
 * WHAT HAPPENED. The plugin installs at USER scope, so this server starts in
 * every Claude Code session on the machine and each one receives the same
 * configured `AGENTSIGNAL_JOIN_TOKEN`. Identity is per checkout, so any
 * project the person had never opened before had no stored agent — and the
 * initialize instructions told that session, before it had seen a single
 * tool, that its FIRST ACTION was to call join_channel.
 *
 * The effect was that opening Claude Code in an unrelated repository
 * registered an agent against the account. Nobody asked for it, nothing
 * reported it, and it compounded with every new project opened. Reported as
 * the thing behaving like a virus, which is a fair description of software
 * that enrolls what it was not pointed at.
 *
 * WHY IT WAS INVISIBLE. Instructions are prose handed to a model, so no type
 * checks them, no route serves them, and no test read them. Every other guard
 * in this codebase is enforced somewhere a test can reach; this one asked a
 * model to do something and was believed because it was phrased confidently.
 * That is the gap this file closes -- the string is now a contract.
 *
 * WHAT IS NOT THE BUG: per-checkout identity. That is what lets a subagent in
 * the same checkout inherit its parent's identity rather than mint a second
 * one, which is the behaviour actually wanted. The defect was that the FIRST
 * registration happened unrequested.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const TOKEN = 'as_join_test0001_abcdefghijklmnopqrstuvwxyz01';

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/**
 * The `instructions` the client is handed at initialize.
 *
 * Read from the initialize RESULT rather than from the source, because what
 * matters is what a model actually receives -- the same reason the dashboard
 * tests drive the served page instead of the file that generates it.
 */
function instructions(env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolveText, reject) => {
    const child = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // Its own empty directory, so a credential on the developer's machine
        // cannot make this look like an already-registered session -- which is
        // the one state where the instruction under test is not produced.
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: mkdtempSync(join(tmpdir(), 'agentsignal-consent-')),
        AGENTSIGNAL_BASE_URL: 'http://127.0.0.1:9',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    running.push(child);

    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no initialize result: ${buffer.slice(0, 400)}`));
    }, 45_000);

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        let message: { id?: unknown; result?: { instructions?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 1) continue;
        clearTimeout(timer);
        child.kill();
        resolveText(message.result?.instructions ?? '');
        return;
      }
    });

    child.on('error', reject);

    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'consent-test', version: '1' },
        },
      }) + '\n',
    );
  });
}

describe('a configured join token is not consent to enroll', () => {
  it('does not tell an unasked session that joining is its first action', async () => {
    const text = await instructions({ AGENTSIGNAL_JOIN_TOKEN: TOKEN });

    // THE ASSERTION. This exact phrasing is what enrolled every project the
    // person opened: a model reading "FIRST ACTION" reasonably does it before
    // anything else, including asking.
    expect(text).not.toMatch(/FIRST ACTION/i);

    // And not merely reworded into the same instruction. "Call join_channel"
    // as an imperative with nothing conditioning it is the same behaviour in
    // a quieter voice.
    expect(text).toMatch(/do not|don't/i);
  }, 60_000);

  it('says to ask first, and names what would be registered', async () => {
    const text = await instructions({ AGENTSIGNAL_JOIN_TOKEN: TOKEN });

    expect(text).toMatch(/ask/i);
    // Consent to "join a channel" is not consent to "register THIS project".
    // The question has to name the thing, or the person is agreeing to a
    // sentence rather than to an action.
    expect(text).toMatch(/project|session/i);
    // The explicit path stays discoverable; removing the automatic join must
    // not remove the way to do it deliberately.
    expect(text).toContain('/agentsignal-join');
  }, 60_000);

  it('still offers the capability rather than hiding it', async () => {
    const text = await instructions({ AGENTSIGNAL_JOIN_TOKEN: TOKEN });

    // The opposite failure, and the reason this is a confirmation rather than
    // a prohibition: somebody who has just followed the setup instructions and
    // configured a token has to be able to use it. A server that says nothing
    // about the token strands the documented onboarding path, which would be a
    // regression dressed as a fix.
    expect(text).toMatch(/join_channel/);
    expect(text).toMatch(/token/i);
  }, 60_000);

  it('offers joining conditionally when nothing is configured', async () => {
    const text = await instructions();

    // NOT absence. The first version of this test asserted join_channel was
    // never mentioned, which failed against correct behaviour: with nothing
    // configured the server says "IF somebody gives you a join code, call
    // join_channel with it". That is the shape wanted everywhere -- the tool
    // named, the action conditioned on a person supplying something. The
    // defect was never the mention, it was the imperative.
    expect(text).toMatch(/if somebody gives you a join code/i);
    expect(text).not.toMatch(/FIRST ACTION/i);
    // And the ways to be useful with nothing set up at all.
    expect(text).toMatch(/open_credit|open_account/);
  }, 60_000);

  it('gives every newly initialized agent the notification routing rules', async () => {
    const text = await instructions();

    expect(text).toContain('Keep your device credential and API key private');
    expect(text).toContain('Call list_people before choosing a recipient');
    expect(text).toContain('The channel agent reviews reports');
    expect(text).toContain('Human-facing notifications only leave the channel agent');
  }, 60_000);
});
