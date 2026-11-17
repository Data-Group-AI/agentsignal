import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Watching a channel is free, and watching it never writes plaintext.
 *
 * TWO PROMISES, one file, because they are made by the same code path.
 *
 * THE FIRST IS ABOUT MONEY. The log endpoint charges a credit per call, and
 * this dashboard polls every two seconds -- so an idle channel billed roughly
 * eighteen hundred times an hour to be told nothing had happened, while
 * re-downloading a hundred messages it already held. The fix is a local copy
 * plus `since`, so a poll asks only for what is new; the API half refunds a
 * call that returns nothing. Neither half works alone: without the local copy
 * there is no `since` to send, and without the refund an empty answer still
 * costs. So the assertion is about the SECOND poll making no upstream request
 * for messages it already has.
 *
 * THE SECOND IS ABOUT SECRECY, and it is the one that would fail silently.
 * Read-once encryption rests on plaintext never being cached; a local store
 * that kept decrypted bodies would void that guarantee with nothing going red
 * and no line in any log. The record of an encrypted message is kept -- who,
 * when, that it happened -- and the contents are not. A test is the only thing
 * that can notice the difference, because both versions look identical from
 * the page.
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

const SECRET_BODY = 'the-plaintext-that-must-not-be-written-to-disk';

/** A stand-in AgentSignal that records what it was asked for. */
const NOW = new Date().toISOString();

async function fakeApi(messages: unknown[]) {
  const asked: string[] = [];
  const probes: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    asked.push(url);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // BEFORE the log branch, which would otherwise swallow it: the answers path
    // also begins `/v1/messages`, and `startsWith` cannot tell them apart.
    if (url.includes('/responses')) {
      const id = url.split('/v1/messages/')[1]?.split('/')[0] ?? '';
      probes.push(id);
      if (id === 'a-question') {
        json({
          ok: true,
          message_id: id,
          options: ['yes', 'no'],
          responses: [
            { recipient_key: 'u_x', name: 'jeff', option_index: 1, responded_at: NOW, changed: false },
          ],
          awaiting: 0,
        });
        return;
      }
      json({ error: { message: 'That message was sent without options.' } }, 400);
      return;
    }

    if (url.startsWith('/v1/messages')) {
      // The real endpoint honours `since` by returning only newer rows. A stub
      // that ignored it would make this test pass against a dashboard that never
      // sent one, which is precisely the bug under test.
      const since = new URL(url, 'http://x').searchParams.get('since');
      const rows = since
        ? (messages as { created_at: string }[]).filter(
            (m) => Date.parse(m.created_at) > Date.parse(since),
          )
        : messages;
      json({ ok: true, channel: { name: 'Test', ref: 'test0001' }, messages: rows });
      return;
    }
    if (url.startsWith('/v1/agents')) {
      json({ ok: true, channel: { name: 'Test', ref: 'test0001' }, recipients: [] });
      return;
    }
    json({ ok: true });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    // The LOG endpoint only. `/v1/messages/<id>/responses` is a different
    // endpoint with a different price, and counting it here would make every
    // billing assertion in this file quietly wrong.
    logReads: () => asked.filter((u) => u.startsWith('/v1/messages') && !u.includes('/responses')),
    probes: () => probes,
  };
}

async function dashboard(api: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-history-'));
  const state = join(home, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ base_url: api, handle: 'someone', key: 'u_someone', credential: 'x.y' }),
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
      AGENTSIGNAL_STATE_DIR: state,
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
    at: (p: string) =>
      `http://127.0.0.1:${url.port}${p}${p.includes('?') ? '&' : '?'}t=${url.searchParams.get('t')}`,
    historyDir: join(home, '.agentsignal', 'history'),
  };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm-' + Math.random().toString(36).slice(2, 10),
  title: 'a title',
  body: 'an ordinary body',
  from_handle: 'planner',
  to_handle: 'someone',
  created_at: new Date(Date.now() - 60_000).toISOString(),
  encrypted: false,
  ...over,
});

describe('polling is free and plaintext is not kept', () => {
  it('asks for everything once, then only for what is new', async () => {
    const api = await fakeApi([message(), message()]);
    const v = await dashboard(api.url);

    const first = await (await fetch(v.at('/messages'))).json();
    expect(first.messages.length).toBe(2);
    expect(first.fetched).toBe(2);

    // THE ASSERTION. The second poll must carry `since` and come back empty --
    // that is what the API refunds, and what makes watching cost nothing.
    const second = await (await fetch(v.at('/messages'))).json();
    expect(second.fetched, 'it re-fetched messages it already had').toBe(0);
    // And still serves the whole conversation from the local copy, rather than
    // showing an empty channel because nothing arrived this second.
    expect(second.messages.length).toBe(2);

    const reads = api.logReads();
    expect(reads.length).toBe(2);
    expect(reads[0], 'the first read should not be narrowed').not.toContain('since=');
    expect(reads[1], 'the second read should ask only for new rows').toContain('since=');
  }, 40_000);

  /**
   * A DELIVERY STATE IS NOT A FACT ABOUT THE PAST.
   *
   * Everything else cached here is immutable -- who sent it, when, what it
   * said. The delivery counts are not: a row is cached a second after it is
   * sent, when it is always pending, and delivers a moment later. With `since`
   * pinned to the newest row held, nothing ever asked again, so the page showed
   * "1 pending" about messages that had landed hours before -- and pending
   * reads, to somebody watching, as "it never arrived". That is what made a
   * working channel get reported as broken.
   */
  it('re-reads a recent pending row, and asks from BEFORE it', async () => {
    const waiting = message({
      id: 'still-waiting',
      created_at: new Date(Date.now() - 5_000).toISOString(),
      pending: 1,
      delivered: 0,
    });
    const api = await fakeApi([waiting]);
    const v = await dashboard(api.url);

    const first = await (await fetch(v.at('/messages'))).json();
    expect(first.messages[0].pending).toBe(1);

    await (await fetch(v.at('/messages'))).json();
    const reads = api.logReads();
    const sinceOf = (u: string) => new URL('http://x' + u).searchParams.get('since');

    // `since` must land BEFORE the row, not on it: the SQL is a strict `>`, so
    // asking from its own stamp returns everything except the row wanted.
    expect(Date.parse(sinceOf(reads[1]!)!)).toBeLessThan(Date.parse(waiting.created_at));

    /*
      THE THROTTLE, which is the half that costs money. Every poll makes one
      call either way -- what decides the bill is whether the answer has rows
      in it, and a wound-back `since` guarantees it does. So the next poll must
      go back to asking only for what is new, or the channel is billed every
      two seconds for as long as one message sits pending.
    */
    await (await fetch(v.at('/messages'))).json();
    const third = api.logReads()[2]!;
    expect(sinceOf(third), 'chasing on every poll bills every poll').toBe(waiting.created_at);
  }, 40_000);

  /**
   * And when it stops chasing, it stops claiming. A row too old to be worth a
   * credit is not evidence of a failed delivery, so it must not keep saying
   * pending -- that is the same wrong answer with a longer half-life.
   */
  it('marks a pending row stale once it is past the chase window', async () => {
    const old = message({
      id: 'long-gone',
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      pending: 1,
      delivered: 0,
    });
    const api = await fakeApi([old]);
    const v = await dashboard(api.url);

    const served = await (await fetch(v.at('/messages'))).json();
    const row = served.messages.find((m: { id: string }) => m.id === 'long-gone');
    expect(row.stale, 'a row nothing is re-reading must say so').toBe(true);

    // And it costs nothing to say it: no second call was made for a row that
    // is past the window.
    await (await fetch(v.at('/messages'))).json();
    expect(api.logReads().length).toBe(2);
  }, 40_000);

  /**
   * AN ANSWER IS NOT A MESSAGE, which is why the conversation looked one-sided.
   *
   * A reply to `ask_agent` comes back as a response attached to the question,
   * and the channel log carries messages -- so a channel where the only inbound
   * traffic was answers rendered as a column of outbound rows and nothing else.
   * Somebody read that, correctly, as never having been replied to. They had
   * been answered twice.
   *
   * The cost is the constraint: that endpoint is priced per call, refunded when
   * it returns nothing to read. So a row is asked about once and then settled
   * -- never a question, or a question with nobody left to reply -- and the
   * only charged call is the first one that comes back with an answer.
   */
  it('shows an answer on its question, and asks about a settled row once', async () => {
    const api = await fakeApi([
      message({ id: 'a-question', title: 'Ready to work?' }),
      message({ id: 'a-statement', title: 'just telling you' }),
    ]);
    const v = await dashboard(api.url);

    const served = await (await fetch(v.at('/messages'))).json();
    const question = served.messages.find((m: { id: string }) => m.id === 'a-question');
    const statement = served.messages.find((m: { id: string }) => m.id === 'a-statement');

    expect(question.answers, 'the reply belongs on the question').toEqual([
      expect.objectContaining({ who: 'jeff', option: 'no' }),
    ]);
    expect(statement.answers, 'a statement has no answers to show').toBeUndefined();

    // Both are settled now -- one answered, one never a question -- so two more
    // polls must not ask again. This is the whole cost story.
    await (await fetch(v.at('/messages'))).json();
    await (await fetch(v.at('/messages'))).json();
    expect(api.probes().filter((id) => id === 'a-question').length).toBe(1);
    expect(api.probes().filter((id) => id === 'a-statement').length).toBe(1);
  }, 40_000);

  /** The one that must never regress. */
  it('records an encrypted message without writing its contents', async () => {
    const api = await fakeApi([
      message({ id: 'plain-1', body: 'ordinary and fine to keep' }),
      message({
        id: 'secret-1',
        encrypted: true,
        title: 'a secret title',
        body: SECRET_BODY,
        from_handle: 'planner',
      }),
    ]);
    const v = await dashboard(api.url);

    const served = await (await fetch(v.at('/messages'))).json();
    expect(served.messages.length).toBe(2);

    // Read the FILE, not the response. The response is allowed to carry
    // whatever the API just said; the guarantee is about what survives on
    // disk after the process that fetched it is gone.
    const files = readdirSync(v.historyDir).filter((n) => n.endsWith('.json'));
    expect(files.length).toBe(1);
    const raw = readFileSync(join(v.historyDir, files[0]!), 'utf8');

    // Searched as TEXT across the whole file, because a body nested somewhere
    // unexpected is still a body on disk. An assertion on one field would pass
    // while the plaintext sat in a sibling the code happened to copy.
    expect(raw, 'plaintext was written to disk').not.toContain(SECRET_BODY);
    expect(raw).not.toContain('a secret title');

    const stored = JSON.parse(raw);
    const secret = stored.messages.find((m: { id: string }) => m.id === 'secret-1');

    // Recorded, not erased: the conversation still reads as a sequence of
    // events, and a message that vanished entirely would be its own kind of
    // lie about what happened.
    expect(secret, 'the encrypted message was dropped entirely').toBeTruthy();
    expect(secret.encrypted).toBe(true);
    expect(secret.from_handle).toBe('planner');
    expect(secret.created_at).toBeTruthy();
    expect(secret.body).toBeNull();
    expect(secret.title).toBeNull();

    // The ordinary one is kept in full, or this test would pass against a
    // store that simply threw everything away.
    const plain = stored.messages.find((m: { id: string }) => m.id === 'plain-1');
    expect(plain.body).toBe('ordinary and fine to keep');
  }, 40_000);

  it('forgets messages older than the retention window', async () => {
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    const api = await fakeApi([
      message({ id: 'ancient', created_at: old }),
      message({ id: 'recent' }),
    ]);
    const v = await dashboard(api.url);

    const served = await (await fetch(v.at('/messages'))).json();
    const ids = served.messages.map((m: { id: string }) => m.id);

    // Default is a week, so a month-old message is not kept -- and the pruning
    // happens on write, so it never reaches the file rather than being hidden
    // by the renderer.
    expect(ids).toContain('recent');
    expect(ids, 'a month-old message survived a seven-day window').not.toContain('ancient');
  }, 40_000);

  it('reports what is stored, and can delete it', async () => {
    const api = await fakeApi([message(), message()]);
    const v = await dashboard(api.url);

    await fetch(v.at('/messages'));
    const before = await (await fetch(v.at('/history'))).json();
    expect(before.messages).toBe(2);
    expect(before.days).toBe(7);
    expect(before.bytes).toBeGreaterThan(0);
    // Measured from the files rather than counted as they are written: a
    // number kept alongside the data drifts from it, and "nothing stored"
    // printed over a full directory is the failure this whole area is about.
    expect(before.channels.length).toBe(1);

    const cleared = await (await fetch(v.at('/history'), { method: 'DELETE' })).json();
    expect(cleared.ok).toBe(true);
    expect(cleared.removed).toBe(1);

    const after = await (await fetch(v.at('/history'))).json();
    expect(after.messages).toBe(0);
    expect(existsSync(join(v.historyDir, 'test0001.json'))).toBe(false);
  }, 40_000);
});
