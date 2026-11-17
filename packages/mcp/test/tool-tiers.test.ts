import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Somewhere empty for the server to look for a remembered credential.
 *
 * Without this the tiers depend on whether the developer running the suite has
 * ever registered an agent on this machine: a real ~/.agentsignal/agent.json
 * would promote the self tier and the first assertion below would fail for a
 * reason that has nothing to do with the code.
 */
const EMPTY_STATE = mkdtempSync(join(tmpdir(), 'agentsignal-tiers-'));

/**
 * Which tools a model is offered, and why it depends only on the environment.
 *
 * The server registers in three tiers: four paid tools with no configuration
 * at all, the keyed set when an API key is present, and the agent set once it
 * has a credential or a join token to get one with. That gating is the whole
 * design -- a tool a model can see is a tool it will try, and spending a turn
 * to be told "not available" is worse than it not being there -- and nothing
 * checked it.
 *
 * Driven over stdio rather than by importing the module, because the module
 * connects a StdioServerTransport at import and would hang a test runner. This
 * also tests what a client actually receives, which is the thing that matters.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');

/** Speak just enough MCP to ask what tools exist. */
function toolsFor(env: Record<string, string>): Promise<string[]> {
  return new Promise((resolveTools, reject) => {
    const child = spawn('npx', ['tsx', SERVER], {
      // A clean environment: inheriting the developer's own AGENTSIGNAL_API_KEY
      // would silently promote every tier and the assertions would all pass.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: EMPTY_STATE,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('no tools/list response'));
    }, 45_000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 2 && message.result?.tools) {
            clearTimeout(timer);
            child.kill();
            resolveTools(message.result.tools.map((t: { name: string }) => t.name).sort());
            return;
          }
        } catch {
          // A partial line; wait for the rest.
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
        clientInfo: { name: 'tier-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

/**
 * What an agent with nothing at all is offered.
 *
 * `open_account` is here rather than in the keyed tier on purpose: it is the
 * tool for an agent that has no key, and putting it behind one would hide the
 * door behind the thing it opens.
 *
 * `join_channel` is here for the same reason, and it is the sharper case. Its
 * credential is an ARGUMENT -- somebody pastes a join code into the chat -- so
 * gating it on already holding a token hid it from exactly the person who had
 * just been handed one. They had to go back to the CLI, write the token into a
 * config file and restart, to do what the running process could have done in
 * one call. A tool whose precondition is its own parameter cannot be tiered on
 * that precondition.
 *
 * Everything else here works on credit alone.
 *
 * A name appearing in this list should always be a decision -- that is what
 * this assertion is for.
 */
const UNKEYED = [
  'check_credit',
  'check_recipient',
  'join_channel',
  'notify_paid',
  'open_account',
  'open_credit',
];

describe('tool tiers', () => {
  it('offers only the unkeyed tools with no environment at all', async () => {
    const tools = await toolsFor({});
    expect(tools).toEqual(UNKEYED);
  }, 60_000);

  it('adds the keyed tools when an API key is present', async () => {
    const tools = await toolsFor({ AGENTSIGNAL_API_KEY: 'as_test_key' });

    for (const unkeyed of UNKEYED) expect(tools).toContain(unkeyed);
    for (const keyed of [
      'notify',
      'notify_many',
      'ask_human',
      'ask_agent',
      'sent_log',
      'report_issue',
      'schedule_message',
      'list_people',
      'list_groups',
      'register_self',
    ]) {
      expect(tools).toContain(keyed);
    }
    // Still gated: no credential and no join token means no acting as itself.
    expect(tools).not.toContain('read_inbox');
    // Minting a join token is an act of the agent, not of the channel's key.
    expect(tools).not.toContain('create_join_token');
    expect(tools).not.toContain('notify_as_self');
  }, 60_000);

  it('adds the agent tools once there is a join token to register with', async () => {
    const tools = await toolsFor({
      AGENTSIGNAL_API_KEY: 'as_test_key',
      AGENTSIGNAL_JOIN_TOKEN: 'as_join_test',
    });

    for (const self of [
      'read_inbox',
      'notify_as_self',
      'respond_to_message',
      'my_channels',
      'create_channel',
      'join_channel',
      'add_agent_to_channel',
      'remove_agent_from_channel',
      'find_agents_in_my_channels',
    ]) {
      expect(tools).toContain(self);
    }
  }, 60_000);
});
