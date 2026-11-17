import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE MACHINE IS A PAGE, and bringing somebody in sits beside who is working.
 *
 * "This machine" had grown to five things -- the onboarding guide, every
 * identity this machine holds, who the channel reaches, connecting a project,
 * and the limits -- inside a <details> in a 15rem rail. A column that narrow
 * turns a settings table into a word per line, and a drawer that long is one
 * people open, scroll, and close without reading.
 *
 * Two of the assertions here are about bugs that were written and then found by
 * hand, which is the reason this file exists rather than a screenshot:
 *
 *   - The panel was hidden with the `hidden` attribute and styled with a bare
 *     `display:flex`. Author display beats the UA `display:none` that `hidden`
 *     relies on, so the whole settings panel rendered above every conversation.
 *   - The invite form went into #rightbody, which workers() rewrites on every
 *     poll -- so a half-typed name, and the code just minted, were wiped a
 *     second or two later. Which is exactly when somebody is reading that code
 *     in order to paste it.
 *
 * Neither would fail a test that only asked whether the markup was present.
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

async function fakeApi() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        channel: { name: 'Default', ref: 'chanaaaa' },
        account: { id: 'acct-one', name: 'Company One' },
        recipients: [],
        messages: [],
      }),
    );
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function dashboard() {
  const api = await fakeApi();
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-page-'));
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-page-state-'));
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({
      base_url: api,
      handle: 'now',
      key: 'u_now',
      credential: 'c',
      api_key: 'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
    }),
  );

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
  const page = async (path: string) => {
    const response = await fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.text() };
  };
  return { origin, cookie, page };
}

describe('the machine gets its own page', () => {
  it('serves /settings as a page, and still refuses it without the token', async () => {
    const v = await dashboard();

    const mine = await v.page('/settings');
    expect(mine.status).toBe(200);
    expect(mine.body).toContain('<div id="settingsbody"');

    /*
      THE GUARD COVERS IT, because a route added to isPage() is a route added to
      the set the token protects. A page without the token gets the note that
      explains where the link comes from -- 401, not the flat 404 an unknown
      path gets -- and, the part that matters, not the shell.
    */
    const stranger = await fetch(`${v.origin}/settings`);
    expect(stranger.status).toBe(401);
    const note = await stranger.text();
    expect(note).toMatch(/ask it for the link/);
    expect(note).not.toContain('settingsbody');
    expect(note).not.toContain('machine-link');
  }, 40_000);

  it('hides the panel in a way a display rule cannot undo', async () => {
    const { body } = await (await dashboard()).page('/');

    // Hidden by default: the conversation is what a bare / is for.
    expect(body).toMatch(/<div id="settingsbody" hidden/);

    /*
      THE BUG THIS EXISTS FOR. `hidden` hides via a UA display:none, and any
      author display rule outranks it. Styling #settingsbody unconditionally put
      the identities table, the limits form and the onboarding guide above every
      conversation -- markup, attribute and all, exactly as intended, and
      visible anyway.
    */
    const rule = /#settingsbody(\S*)\s*\{[^}]*display\s*:/.exec(body);
    expect(rule, 'no display rule for #settingsbody at all').toBeTruthy();
    expect(rule![1], 'a display rule on #settingsbody must exclude [hidden]').toContain(
      ':not([hidden])',
    );
  }, 40_000);

  it('puts bringing somebody in beside who is working, in a box of its own', async () => {
    const { body } = await (await dashboard()).page('/');

    const right = /<aside id="right"[\s\S]*?<\/aside>/.exec(body);
    expect(right, 'no right-hand column').toBeTruthy();
    expect(right![0]).toContain('id="invitebox"');

    /*
      A BOX OF ITS OWN, not #rightbody. workers() rewrites #rightbody on every
      poll, so an invite form in there loses whatever is half-typed in it -- and
      loses the minted code, which is shown once and read in order to be pasted.
    */
    expect(right![0]).toMatch(/id="rightbody"[\s\S]*id="invitebox"/);
    // Served empty, and filled by workers() on every poll. The form must not be
    // in there, so the shell must not put anything in there either.
    expect(right![0]).toMatch(/<div id="rightbody"><\/div>/);
    // And the form's markup is written to the OTHER box: the reference and the
    // <form> sit together, in one statement, close enough to prove which.
    expect(body).toMatch(/invitebox[\s\S]{0,400}<form id="invite">/);
  }, 40_000);

  it('replaces the rail drawer with a link to the page', async () => {
    const { body } = await (await dashboard()).page('/');

    expect(body).toContain('id="machine-link"');
    expect(body).toMatch(/<a id="machine-link" href="\/settings"/);
    // The drawer is gone rather than hidden: two ways into the same settings,
    // one of them a 15rem column, is the thing this replaced.
    expect(body).not.toContain('<details id="setup">');
    expect(body).not.toContain('id="setupbody"');
  }, 40_000);
});
