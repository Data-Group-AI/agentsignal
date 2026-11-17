import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Clicking an agent in the dashboard's nav.
 *
 * IT USED TO SAY "Not found." The nav built `href="/a/<handle>"` with no query, and the
 * request guard refuses anything whose `?t=` does not match the run's token. So the click
 * navigated, dropped the token, and was refused. `href="/"` — "whole channel" — had the same
 * defect. Verified by curl at the time: `/a/planner` 404, `/a/planner?t=<token>` 200.
 *
 * The 404 is deliberately uninformative and MUST STAY THAT WAY: a page reading "unauthorised,
 * this is the AgentSignal dashboard" tells a scanner exactly what it found. The cost is that a
 * dropped credential is indistinguishable from a missing agent, so the message sent people
 * looking for the agent instead of at the link that lost the token.
 *
 * ⚠ THE FIX IS NOT A REPAIRED LINK. Filtering happens in the page — no navigation, so there is
 * no request, so there is nothing to drop and the whole class of bug goes away. What has to
 * hold, and is asserted below:
 *
 *   • the guard is untouched, and still refuses without the token
 *   • the token is NOT in the markup — it authorises send and answer on a dashboard holding a
 *     real API key, and a value in the DOM is one a stray script can read without navigating
 *   • the nav therefore carries `data-agent`, which the click handler reads instead of href
 *   • a cold load of /a/<agent>?t=… still renders, because people paste those
 *   • filtering covers BOTH directions of a conversation, not just an inbox
 *   • pushState keeps the query, or a reload of what it left in the bar would be refused
 *
 * The companion suite `the-dashboard-is-not-open.test.ts` owns the guard itself. This one owns the
 * part that made the guard look like the wrong bug.
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

/**
 * A stand-in AgentSignal with two agents and traffic in both directions, so "both directions"
 * is a claim the messages can actually falsify.
 */
async function fakeApi() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });

    if ((req.url ?? '').startsWith('/v1/agents')) {
      res.end(
        JSON.stringify({
          ok: true,
          channel: { name: 'Test', ref: 'test0001', is_sandbox: true },
          recipients: [
            { key: 'u_planner', handle: 'planner', is_agent: true, reachable: true },
            { key: 'u_builder', handle: 'builder', is_agent: true, reachable: true },
          ],
        }),
      );
      return;
    }

    res.end(
      JSON.stringify({
        ok: true,
        channel: { name: 'Test', ref: 'test0001' },
        messages: [
          // TO planner — an inbox-only filter would keep this one.
          { id: '1', from: 'u_builder', from_handle: 'builder', to: 'u_planner', to_handle: 'planner', title: 'to-planner' },
          // FROM planner — an inbox-only filter would LOSE this one, which is the bug
          // "both directions" names.
          { id: '2', from: 'u_planner', from_handle: 'planner', to: 'u_builder', to_handle: 'builder', title: 'from-planner' },
          // Neither end is planner. Must not appear in a planner view.
          { id: '3', from: 'u_builder', from_handle: 'builder', to: 'u_someone', to_handle: 'someone', title: 'unrelated' },
        ],
      }),
    );
  });

  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));

  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Start the dashboard and hand back its port and the token it printed. */
async function dashboard(api: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-filter-'));
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, 'state', 'agent.json'),
    JSON.stringify({
      base_url: api,
      handle: 'someone',
      key: 'u_someone',
      credential: 'install.secret',
    }),
  );

  const child = spawn(process.execPath, [VIEWER], {
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      AGENTSIGNAL_API_KEY: 'as_test_test0001_000000000000000000000000000000000',
      AGENTSIGNAL_BASE_URL: api,
      // Passed through so a spawned server obeys the same keychain switch as the
      // runner. Empty means "not set", which is what an ordinary run looks like.
      AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
      AGENTSIGNAL_STATE_DIR: join(home, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const printed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard never printed a URL: ${out}`)), 12_000);
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

  return { port: url.port, token: url.searchParams.get('t')! };
}

/** Pull one function's source out of the served page, so what is exercised is what ships. */
function lift(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);

  if (start < 0) throw new Error(`not found in the served page: ${name} — renamed?`);

  let depth = 0;

  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }

  throw new Error(`unbalanced braces: ${name}`);
}

describe('clicking an agent filters the channel instead of leaving it', () => {
  it('still refuses a tokenless load, and says nothing about why', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const at = (p: string) => `http://127.0.0.1:${v.port}${p}`;

    // The reported symptom, and it is still refused. The fix is that nothing in the UI
    // produces this request any more — not that the request started succeeding.
    //
    // 401 rather than the original 404 because these two are the routes a PERSON
    // types, and they now say a link is needed: a bare 404 was indistinguishable
    // from a dead server for anyone who bookmarked the clean address. What they
    // are still not allowed to do is identify themselves, which is the assertion
    // below and is unchanged.
    expect((await fetch(at('/a/planner'))).status).toBe(401);
    expect((await fetch(at('/'))).status).toBe(401);
    expect((await fetch(at('/a/planner?t=not-the-token'))).status).toBe(401);

    const refused = await fetch(at('/a/planner'));
    const body = await refused.text();

    expect(body).toContain('needs its link');
    expect(body).not.toMatch(/agentsignal|viewer|token|unauthoris/i);
  });

  it('renders a pasted /a/<agent> link, which is the only way to deep-link', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);

    const page = await fetch(`http://127.0.0.1:${v.port}/a/planner?t=${v.token}`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('who-nav');
  });

  it('keeps the token out of the markup, and hands the nav data-agent instead', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);

    const html = await (await fetch(`http://127.0.0.1:${v.port}/a/planner?t=${v.token}`)).text();

    // The whole reason the href cannot carry it.
    expect(html).not.toContain(v.token);

    // What the click handler reads instead.
    expect(html).toContain('data-agent');
    // And the href stays token-free, so a regression that "fixes" the link by pasting the
    // token into the DOM fails here.
    expect(html).not.toMatch(/href="\/a\/[^"]*t=/);
  });

  it('filters both directions of a conversation, not just an inbox', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const at = (p: string) => `http://127.0.0.1:${v.port}${p}`;

    const all = await (await fetch(at(`/messages?t=${v.token}`))).json();
    expect(all.messages.map((m: { title: string }) => m.title)).toEqual([
      'to-planner',
      'from-planner',
      'unrelated',
    ]);

    const planner = await (await fetch(at(`/messages?agent=planner&t=${v.token}`))).json();
    const titles = planner.messages.map((m: { title: string }) => m.title);

    // BOTH, and nothing else. Dropping 'from-planner' is the inbox-only bug; keeping
    // 'unrelated' would mean the browser holds traffic this view did not ask for.
    expect(titles).toContain('to-planner');
    expect(titles).toContain('from-planner');
    expect(titles).not.toContain('unrelated');
  });

  it('derives the agent from the path, and pushState keeps the query', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);

    const html = await (await fetch(`http://127.0.0.1:${v.port}/a/planner?t=${v.token}`)).text();
    // `!` covers the match being null; it does not cover the capture group,
    // which `noUncheckedIndexedAccess` types as possibly undefined. Narrowed
    // with a thrown message rather than a second `!` because the two failures
    // read completely differently: if the page ever stops carrying an inline
    // script, this says so, where an assertion would surface as "cannot read
    // properties of undefined" inside a helper three frames away.
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('the served page carried no inline script — has the dashboard changed shape?');

    // Exercised as the browser gets it. This file's client code lives inside a template
    // literal, where a doubled backslash is easy to get wrong and a filter that silently
    // stops matching is what that mistake produces.
    const agentFromPath = new Function(`${lift(script, 'agentFromPath')} return agentFromPath;`)() as (
      p: string,
    ) => string;

    expect(agentFromPath('/')).toBe('');
    expect(agentFromPath('/a/planner')).toBe('planner');
    expect(agentFromPath('/a/planner/')).toBe('planner');
    expect(agentFromPath('/a/some%20one')).toBe('some one');

    // ⚠ THE QUERY MUST SURVIVE. Whatever pushState leaves in the address bar is what a reload
    // asks for, and the guard refuses a request without ?t=. A filterTo() that pushes a bare
    // path leaves the page one refresh away from "Not found."
    const pushed: string[] = [];
    const run = new Function(
      'history',
      'location',
      'markNav',
      'tick',
      `let AGENT = ''; ${lift(script, 'filterTo')} return (a) => { filterTo(a, true); return AGENT; };`,
    )(
      { pushState: (_s: unknown, _t: string, url: string) => pushed.push(url) },
      { search: '?t=abc123' },
      () => {},
      () => {},
    ) as (a: string) => string;

    expect(run('planner')).toBe('planner');
    expect(pushed[0]).toBe('/a/planner?t=abc123');

    expect(run('')).toBe('');
    expect(pushed[1]).toBe('/?t=abc123');
  });
});
