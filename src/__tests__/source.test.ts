/**
 * v2 source suite: connect (password-vault prompt + auth.test/scope
 * validation), pull (resumable page-aligned backfill / budgeted delta with
 * the complete-day clamp), error guards, and the pure toDocument mapping.
 *
 * `host.net.fetch` is fully scripted — no real network. `fakeSlack` routes
 * Slack Web API calls by method name to per-method FIFO response queues and
 * serves url_private downloads from a byte map, recording every call
 * (method + form params) in order. The clock is pinned to NOW (2024-01-05)
 * via the source's test seam, so active-thread windows and last_polled
 * stamps are deterministic; TZ=UTC (jest.config.js) pins local-day math.
 */
import { createSlackSource } from '../source';
import type { NetFetch } from '../client';
import type {
  ActiveThread,
  SlackCursor,
  SlackItem,
  SlackMessage,
} from '../types';
import type {
  Account,
  AuthChannel,
  Batch,
  Credentials,
  DocumentInput,
  HostFor,
  Session,
} from '../kiagent-contracts';

const NOW_MS = Date.parse('2024-01-05T00:00:00.000Z');

// Local (UTC) day boundaries used across the scripted workspace.
const DAY1 = '2024-01-01'; // 1704067200
const DAY2 = '2024-01-02'; // 1704153600
const DAY3 = '2024-01-03'; // 1704240000

function jsonResponse(
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
) {
  return {
    status,
    statusText: '',
    headers,
    body: new TextEncoder().encode(JSON.stringify(json)),
  };
}

interface RecordedCall {
  method: string;
  params: Record<string, string>;
}

interface SlackScript {
  methods?: Record<string, Array<Record<string, unknown>>>;
  downloads?: Record<string, Uint8Array>;
}

/** Scripted Slack Web API: per-method FIFO queues of envelope JSON, plus a
 *  url → bytes map for url_private downloads (a miss serves HTTP 404). */
function fakeSlack(script: SlackScript) {
  const calls: RecordedCall[] = [];
  const fetchFn: NetFetch = async (url, init) => {
    if (!url.startsWith('https://slack.com/api/')) {
      calls.push({ method: 'download', params: { url } });
      const bytes = script.downloads?.[url];
      if (!bytes) return jsonResponse(404, {});
      return { status: 200, statusText: '', headers: {}, body: bytes };
    }
    const method = url.slice('https://slack.com/api/'.length);
    const i = (init ?? {}) as { body?: string };
    const params = Object.fromEntries(new URLSearchParams(i.body ?? ''));
    calls.push({ method, params });
    const json = script.methods?.[method]?.shift();
    if (json === undefined) {
      throw new Error(
        `fakeSlack: no response queued for ${method} ${JSON.stringify(params)}`,
      );
    }
    return jsonResponse(200, json);
  };
  return { fetchFn, calls };
}

function makeHost(fetchFn: NetFetch): HostFor<'net'> {
  return {
    self: { id: 'slack', dataDir: '/tmp' },
    log: () => {},
    net: { fetch: fetchFn },
  };
}

function makeSource(fetchFn: NetFetch, requestBudget?: number) {
  return createSlackSource(makeHost(fetchFn), {
    sleep: async () => {},
    now: () => NOW_MS,
    requestBudget,
  });
}

function makeSession(
  credentials: Credentials | null,
  warnings: string[] = [],
): Session {
  return {
    account: {
      id: 'acc1',
      identifier: 'Acme',
      config: { team_id: 'T1', team_url: 'https://acme.slack.com/' },
    } as unknown as Account,
    signal: new AbortController().signal,
    credentials: async () => credentials,
    log: (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    },
  };
}

const CREDS = { password: 'xoxp-test-deadbeef' };

async function drain(
  iter: AsyncIterable<Batch<SlackCursor, SlackItem>>,
): Promise<Array<Batch<SlackCursor, SlackItem>>> {
  const out: Array<Batch<SlackCursor, SlackItem>> = [];
  for await (const b of iter) out.push(b);
  return out;
}

const ok = (extra: Record<string, unknown>) => ({ ok: true, ...extra });

const usersPage = () =>
  ok({
    members: [
      { id: 'U1', profile: { display_name: 'alice' } },
      { id: 'U2', profile: { real_name: 'Bob B' } },
    ],
  });

// ── The scripted workspace (backfill) ────────────────────────────────────────

const F1 = {
  id: 'F1',
  name: 'notes.pdf',
  mimetype: 'application/pdf',
  size: 5,
  url_private: 'https://files.slack.com/F1',
};
const F1_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

const ROOT_TS = '1704240500.000100';
const mDay3: SlackMessage = { ts: '1704240600.000100', user: 'U1', text: 'day3 *hello*' };
const mRoot: SlackMessage = {
  ts: ROOT_TS,
  user: 'U2',
  text: 'thread root &amp; more',
  thread_ts: ROOT_TS,
  reply_count: 1,
  latest_reply: '1704240550.000200',
};
const mJoin: SlackMessage = {
  ts: '1704240400.000100',
  user: 'U1',
  subtype: 'channel_join',
  text: 'alice joined',
};
const mDay2b: SlackMessage = {
  ts: '1704153700.000100',
  user: 'U1',
  text: 'day2 with file',
  files: [F1],
};
const mDay2a: SlackMessage = { ts: '1704153650.000100', user: 'U2', text: 'day2 older' };
const mDay1: SlackMessage = { ts: '1704067300.000100', user: 'U1', text: 'day1 msg' };
const mDm: SlackMessage = { ts: '1704240700.000100', user: 'U2', text: 'dm hi' };

const threadReplies = () =>
  ok({
    messages: [
      { ...mRoot },
      { ts: '1704240550.000200', thread_ts: ROOT_TS, user: 'U1', text: 'a reply' },
    ],
  });

function backfillScript(): SlackScript {
  return {
    methods: {
      'users.list': [usersPage()],
      'conversations.list': [
        ok({
          channels: [
            { id: 'C1', name: 'general', is_member: true },
            { id: 'C9', name: 'not-a-member', is_member: false },
            { id: 'D1', is_im: true, user: 'U2' },
          ],
        }),
      ],
      'conversations.history': [
        // C1 page 1 (newest→oldest), has a successor
        ok({
          messages: [mDay3, mRoot, mJoin, mDay2b],
          response_metadata: { next_cursor: 'c1p2' },
        }),
        // C1 page 2 (final)
        ok({ messages: [mDay2a, mDay1] }),
        // D1 single page
        ok({ messages: [mDm] }),
      ],
      'conversations.replies': [threadReplies()],
    },
    downloads: { 'https://files.slack.com/F1': F1_BYTES },
  };
}

const itemKinds = (b: Batch<SlackCursor, SlackItem>) => b.items.map((i) => i.kind);

// ─────────────────────────────────────────────────────────────────────────────

describe('connect', () => {
  function makeAuth(answers: Record<string, unknown>) {
    let schema: unknown;
    const auth: AuthChannel = {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async (s) => {
        schema = s;
        return answers;
      },
      status: () => {},
    };
    return { auth, getSchema: () => schema };
  }

  const ALL_SCOPES =
    'channels:history, channels:read, groups:history, groups:read, im:history, im:read, mpim:history, mpim:read, users:read, files:read';

  it('prompts with a password field and rejects a bot token BEFORE any network call', async () => {
    const calls: string[] = [];
    const source = makeSource(async (url) => {
      calls.push(url);
      throw new Error('must not fetch');
    });
    const { auth, getSchema } = makeAuth({ password: ' xoxb-test-cafebabe ' });

    await expect(source.connect(auth)).rejects.toThrow(/Bot token/);

    const schema = getSchema() as {
      required: string[];
      properties: Record<string, { format?: string; examples?: string[] }>;
      'x-steps': Array<{ title: string; link?: string; copy?: string }>;
    };
    expect(schema.required).toEqual(['password']);
    expect(schema.properties.password.format).toBe('password');
    expect(calls).toHaveLength(0);

    // The schema carries the guided-setup conventions the app renders.
    expect(schema['x-steps']).toHaveLength(2);
    expect(schema['x-steps'][0].link).toBe('https://api.slack.com/apps?new_app=1');
    expect(schema['x-steps'][0].copy).toContain('- channels:history');
    expect(schema.properties.password.examples?.[0]).toBe('xoxp-…');
  });

  it('rejects any non-xoxp prefix before the network', async () => {
    const source = makeSource(async () => {
      throw new Error('must not fetch');
    });
    const { auth } = makeAuth({ password: 'IGQVJtest-not-slack' });

    await expect(source.connect(auth)).rejects.toThrow(/starting with xoxp-/);
  });

  it('lists the missing scopes when the token is under-scoped', async () => {
    const source = makeSource(async () =>
      jsonResponse(
        200,
        { ok: true, team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/' },
        { 'x-oauth-scopes': 'channels:history, channels:read' },
      ),
    );
    const { auth } = makeAuth({ password: 'xoxp-test-deadbeef' });

    await expect(source.connect(auth)).rejects.toThrow(
      /missing scopes: groups:history, groups:read, im:history/,
    );
  });

  it('surfaces Slack rejecting the token (auth.test ok:false)', async () => {
    const source = makeSource(async () =>
      jsonResponse(200, { ok: false, error: 'invalid_auth' }, { 'x-oauth-scopes': ALL_SCOPES }),
    );
    const { auth } = makeAuth({ password: 'xoxp-test-deadbeef' });

    await expect(source.connect(auth)).rejects.toThrow(
      /Slack rejected the token: invalid_auth/,
    );
  });

  it('returns the team name identifier and team_id/team_url config on success', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const source = makeSource(async (url, init) => {
      seen.push({
        url,
        headers: (init as { headers: Record<string, string> }).headers,
      });
      return jsonResponse(
        200,
        { ok: true, team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/' },
        { 'x-oauth-scopes': ALL_SCOPES },
      );
    });
    const { auth } = makeAuth({ password: '  xoxp-test-deadbeef  ' });

    const result = await source.connect(auth);

    expect(result).toEqual({
      identifier: 'Acme',
      config: { team_id: 'T1', team_url: 'https://acme.slack.com/' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://slack.com/api/auth.test');
    // the pasted token is trimmed before use
    expect(seen[0].headers.authorization).toBe('Bearer xoxp-test-deadbeef');
  });
});

describe('pull — backfill', () => {
  it('walks the scripted workspace: one batch per history page, completion advances backfill_done, then flips to live', async () => {
    const { fetchFn, calls } = fakeSlack(backfillScript());
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const batches = await drain(source.pull(session, null));

    expect(batches).toHaveLength(4);
    expect(batches.map((b) => b.phase)).toEqual([
      'backfill',
      'backfill',
      'backfill',
      'live',
    ]);

    // Batch 0 — C1 page 1: the thread doc plus day3 (flushed when day2 appeared).
    expect(itemKinds(batches[0])).toEqual(['thread', 'day']);
    const thread = batches[0].items[0];
    if (thread.kind !== 'thread') throw new Error('expected thread');
    expect(thread.threadTs).toBe(ROOT_TS);
    expect(thread.channelName).toBe('#general');
    expect(thread.messages.map((m) => [m.userName, m.text])).toEqual([
      ['Bob B', 'thread root & more'], // &amp; unescaped at pull time
      ['alice', 'a reply'],
    ]);
    const day3 = batches[0].items[1];
    if (day3.kind !== 'day') throw new Error('expected day');
    expect(day3.day).toBe(DAY3);
    expect(day3.convKind).toBe('public_channel');
    expect(day3.teamUrl).toBe('https://acme.slack.com/');
    expect(day3.messages.map((m) => m.text)).toEqual(['day3 **hello**']); // mrkdwn rendered
    // the join message was skipped, the broadcast rule kept the root out of day docs

    // Batch 0 cursor — page-aligned resume point incl. the buffered day2.
    expect(batches[0].cursor).toEqual({
      conversations: {},
      active_threads: [],
      backfill_done: [],
      backfill_progress: {
        conversation_id: 'C1',
        next_cursor: 'c1p2',
        latest_ts: mDay3.ts,
        active_threads: [
          { channel: 'C1', thread_ts: ROOT_TS, last_reply_ts: '1704240550.000200' },
        ],
        day: DAY2,
        day_buf: [mDay2b],
      },
    });

    // Batch 1 — C1 completion: day2 (COMPLETE, spanning both pages) + its
    // file (same batch as its parent) + day1, cursor advances backfill_done.
    expect(itemKinds(batches[1])).toEqual(['day', 'file', 'day']);
    const day2 = batches[1].items[0];
    if (day2.kind !== 'day') throw new Error('expected day');
    expect(day2.day).toBe(DAY2);
    expect(day2.messages.map((m) => m.ts)).toEqual([mDay2a.ts, mDay2b.ts]); // ascending
    const file = batches[1].items[1];
    if (file.kind !== 'file') throw new Error('expected file');
    expect(file.id).toBe('F1');
    expect(file.bytes).toEqual(F1_BYTES);
    expect(file.parentExternalId).toBe(`C1:${DAY2}`);
    expect(file.parentType).toBe('slack.day');
    expect(batches[1].cursor.backfill_progress).toBeUndefined();
    expect(batches[1].cursor.backfill_done).toEqual(['C1']);
    expect(batches[1].cursor.conversations).toEqual({
      C1: { latest_ts: mDay3.ts, name: '#general', kind: 'public_channel' },
    });
    expect(batches[1].cursor.active_threads).toEqual([
      { channel: 'C1', thread_ts: ROOT_TS, last_reply_ts: '1704240550.000200' },
    ]);

    // Batch 2 — D1 (im) completion.
    expect(itemKinds(batches[2])).toEqual(['day']);
    const dmDay = batches[2].items[0];
    if (dmDay.kind !== 'day') throw new Error('expected day');
    expect(dmDay.channelName).toBe('DM with Bob B');
    expect(dmDay.convKind).toBe('im');
    expect(batches[2].cursor.backfill_done).toEqual(['C1', 'D1']);

    // Batch 3 — the live flip: backfill bookkeeping gone, polls floor set.
    expect(batches[3]).toEqual({
      phase: 'live',
      items: [],
      cursor: {
        conversations: {
          C1: { latest_ts: mDay3.ts, name: '#general', kind: 'public_channel' },
          D1: { latest_ts: mDm.ts, name: 'DM with Bob B', kind: 'im' },
        },
        active_threads: [
          { channel: 'C1', thread_ts: ROOT_TS, last_reply_ts: '1704240550.000200' },
        ],
        polls: 0,
      },
    });

    // Request shape: C1's second page carried the saved page cursor; the
    // non-member channel C9 was never walked.
    const historyCalls = calls.filter((c) => c.method === 'conversations.history');
    expect(historyCalls.map((c) => [c.params.channel, c.params.cursor])).toEqual([
      ['C1', undefined],
      ['C1', 'c1p2'],
      ['D1', undefined],
    ]);
  });

  it('resumes mid-conversation from backfill_progress: the first history call carries the saved cursor and the buffered day survives', async () => {
    const script = backfillScript();
    script.methods!['conversations.list'] = [
      ok({ channels: [{ id: 'C1', name: 'general', is_member: true }] }),
    ];
    script.methods!['conversations.history'] = [ok({ messages: [mDay2a, mDay1] })];
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const resumeCursor: SlackCursor = {
      conversations: {},
      active_threads: [],
      backfill_done: [],
      backfill_progress: {
        conversation_id: 'C1',
        next_cursor: 'c1p2',
        latest_ts: mDay3.ts,
        active_threads: [],
        day: DAY2,
        day_buf: [mDay2b],
      },
    };
    const batches = await drain(source.pull(session, resumeCursor));

    const historyCalls = calls.filter((c) => c.method === 'conversations.history');
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0].params.cursor).toBe('c1p2');

    // completion + live flip
    expect(batches).toHaveLength(2);
    const day2 = batches[0].items.find(
      (i): i is Extract<SlackItem, { kind: 'day' }> =>
        i.kind === 'day' && i.day === DAY2,
    )!;
    // the checkpointed day_buf message re-joined the day — no silent loss
    expect(day2.messages.map((m) => m.ts)).toEqual([mDay2a.ts, mDay2b.ts]);
    expect(batches[0].cursor.backfill_done).toEqual(['C1']);
    expect(batches[0].cursor.conversations.C1.latest_ts).toBe(mDay3.ts);
  });

  it('falls back to a fresh re-walk when Slack rejects the saved page cursor', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.list': [
          ok({ channels: [{ id: 'C1', name: 'general', is_member: true }] }),
        ],
        'conversations.history': [
          { ok: false, error: 'invalid_cursor' }, // resumed call rejected
          ok({ messages: [mDay1] }), // fresh walk succeeds
        ],
      },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const warnings: string[] = [];
    const session = makeSession(CREDS, warnings);

    const batches = await drain(
      source.pull(session, {
        conversations: {},
        active_threads: [],
        backfill_done: [],
        backfill_progress: {
          conversation_id: 'C1',
          next_cursor: 'stale-cursor',
          latest_ts: mDay3.ts,
          active_threads: [],
          day: null,
          day_buf: [],
        },
      }),
    );

    const historyCalls = calls.filter((c) => c.method === 'conversations.history');
    expect(historyCalls.map((c) => c.params.cursor)).toEqual(['stale-cursor', undefined]);
    expect(warnings.some((w) => w.includes('restarting the conversation'))).toBe(true);
    // fresh walk completed the conversation
    expect(batches.at(-1)!.cursor.conversations.C1).toBeDefined();
    expect(batches.at(-1)!.cursor.conversations.C1.latest_ts).toBe(mDay1.ts);
  });

  it('skips a conversation that fails mid-backfill DURABLY (backfill_done advances past it) and keeps walking', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.list': [
          ok({
            channels: [
              { id: 'C1', name: 'general', is_member: true },
              { id: 'C2', name: 'dev', is_member: true },
            ],
          }),
        ],
        'conversations.history': [
          { ok: false, error: 'fatal_error' }, // C1 breaks (non-auth, no resume)
          ok({ messages: [mDay1] }), // C2 walks fine
        ],
      },
    };
    const { fetchFn } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const warnings: string[] = [];
    const session = makeSession(CREDS, warnings);

    const batches = await drain(source.pull(session, null));

    expect(warnings.some((w) => w.includes('C1') && w.includes('skipped'))).toBe(true);
    // C1's failure batch is empty but advances backfill_done durably.
    expect(batches[0].items).toEqual([]);
    expect(batches[0].cursor.backfill_done).toEqual(['C1']);
    expect(batches[0].cursor.conversations).toEqual({});
    // C2 still completed; the final cursor never contains the broken C1.
    const last = batches.at(-1)!;
    expect(Object.keys(last.cursor.conversations)).toEqual(['C2']);
  });

  it('skips one unreadable thread with a warning without aborting the walk', async () => {
    const script = backfillScript();
    script.methods!['conversations.list'] = [
      ok({ channels: [{ id: 'C1', name: 'general', is_member: true }] }),
    ];
    script.methods!['conversations.history'] = [ok({ messages: [mDay3, mRoot] })];
    script.methods!['conversations.replies'] = [{ ok: false, error: 'thread_not_found' }];
    const { fetchFn } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const warnings: string[] = [];
    const session = makeSession(CREDS, warnings);

    const batches = await drain(source.pull(session, null));

    expect(warnings.some((w) => w.includes(`skipping thread C1:${ROOT_TS}`))).toBe(true);
    // day3 still ingested; no thread item anywhere.
    const kinds = batches.flatMap(itemKinds);
    expect(kinds).toEqual(['day']);
    // the conversation still completed (latest_ts advanced past the root).
    expect(batches.at(-1)!.cursor.conversations.C1.latest_ts).toBe(mDay3.ts);
  });

  it('propagates auth errors with a "reconnect the account" message instead of skipping', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.list': [
          ok({ channels: [{ id: 'C1', name: 'general', is_member: true }] }),
        ],
        'conversations.history': [{ ok: false, error: 'invalid_auth' }],
      },
    };
    const { fetchFn } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    await expect(drain(source.pull(session, null))).rejects.toThrow(
      /invalid_auth — reconnect the account$/,
    );
  });

  it('throws before any fetch when the vault has no credentials', async () => {
    const { fetchFn, calls } = fakeSlack({});
    const source = makeSource(fetchFn);
    const session = makeSession(null);

    await expect(drain(source.pull(session, null))).rejects.toThrow(
      /no Slack credentials — reconnect the account/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('pull — delta', () => {
  const liveCursor = (over: Partial<SlackCursor> = {}): SlackCursor => ({
    conversations: {
      C1: {
        latest_ts: '1704240600.000100', // day3 00:10
        name: '#general',
        kind: 'public_channel',
        last_polled: '2024-01-04T00:00:00.000Z',
      },
      C2: {
        latest_ts: '1704326400.000100', // day4 00:00
        name: '#dev',
        kind: 'public_channel',
        // no last_polled → stalest, polled first
      },
    },
    active_threads: [],
    polls: 3, // 3+1 = 4 → no membership refresh this poll
    ...over,
  });

  it('polls stalest-first with the oldest param clamped to the LOCAL DAY START of (latest_ts − 24h), re-rendering complete days', async () => {
    const mNew: SlackMessage = { ts: '1704240800.000100', user: 'U2', text: 'newest' };
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [
          ok({ messages: [] }), // C2 — nothing new
          ok({ messages: [mNew, mDay2b, mDay2a] }), // C1 window re-read
        ],
      },
      downloads: { 'https://files.slack.com/F1': F1_BYTES },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const batches = await drain(source.pull(session, liveCursor()));

    // Stalest first: C2 (never polled) before C1.
    const history = calls.filter((c) => c.method === 'conversations.history');
    expect(history.map((c) => c.params.channel)).toEqual(['C2', 'C1']);
    // C2: 1704326400 − 86400 = 1704240000.0001 → day3 starts at 1704240000.
    // C1: 1704240600 − 86400 = 1704154200.0001 → day2 starts at 1704153600.
    // Both are LOWER than the raw 24h-lookback — the complete-day clamp.
    expect(history.map((c) => c.params.oldest)).toEqual(['1704240000', '1704153600']);

    // one batch per polled channel + the final bookkeeping batch
    expect(batches).toHaveLength(3);
    expect(batches[0].items).toEqual([]); // C2 empty
    expect(batches[0].cursor.conversations.C2.last_polled).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(batches[0].cursor.polls).toBe(4);

    // C1's batch re-renders BOTH fetched days completely; the file rides along.
    expect(itemKinds(batches[1])).toEqual(['day', 'file', 'day']);
    const day2 = batches[1].items[0];
    if (day2.kind !== 'day') throw new Error('expected day');
    expect(day2.day).toBe(DAY2);
    expect(day2.messages.map((m) => m.ts)).toEqual([mDay2a.ts, mDay2b.ts]);
    const day3 = batches[1].items[2];
    if (day3.kind !== 'day') throw new Error('expected day');
    expect(day3.day).toBe(DAY3);
    // latest_ts advanced only in the batch that carries C1's items
    expect(batches[0].cursor.conversations.C1.latest_ts).toBe('1704240600.000100');
    expect(batches[1].cursor.conversations.C1.latest_ts).toBe(mNew.ts);

    expect(batches[2].items).toEqual([]); // final bookkeeping batch
  });

  it('re-walks a long-dormant channel page-aligned (bounded batches, crash-safe cursor) instead of draining the backlog into one batch, while a fresh channel keeps the fast path', async () => {
    // C1 slept since 2023-11-26 → oldest clamps to 2023-11-25 00:00 UTC
    // (1700870400); the window to NOW is ~41 days > MAX_DRAIN_WINDOW_SECONDS.
    const mP1a: SlackMessage = { ts: '1704240600.000100', user: 'U1', text: 'jan 3' };
    const mP1b: SlackMessage = { ts: '1704153700.000100', user: 'U1', text: 'jan 2 late' };
    const mP2a: SlackMessage = { ts: '1704153650.000100', user: 'U2', text: 'jan 2 early' };
    const mP2b: SlackMessage = { ts: '1700954000.000100', user: 'U1', text: 'november' };
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [
          // C1 backlog, two pages newest→oldest
          ok({ messages: [mP1a, mP1b], response_metadata: { next_cursor: 'w2' } }),
          ok({ messages: [mP2a, mP2b] }),
          // C2 fast-path poll
          ok({ messages: [] }),
        ],
      },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const cursor: SlackCursor = {
      conversations: {
        C1: { latest_ts: '1701000000.000100', name: '#general', kind: 'public_channel' },
        C2: {
          latest_ts: '1704326400.000100',
          name: '#dev',
          kind: 'public_channel',
          last_polled: '2024-01-04T00:00:00.000Z',
        },
      },
      active_threads: [],
      polls: 3,
    };
    const batches = await drain(source.pull(session, cursor));

    const history = calls.filter((c) => c.method === 'conversations.history');
    // C1's walk is bounded below by the SAME day-start clamp and pages
    // through the backlog; C2 stays on the single-call fast path.
    expect(history.map((c) => [c.params.channel, c.params.oldest, c.params.cursor])).toEqual([
      ['C1', '1700870400', undefined],
      ['C1', '1700870400', 'w2'],
      ['C2', '1704240000', undefined],
    ]);

    // [C1 page batch, C1 completion, C2 poll, final] — never one giant batch.
    expect(batches).toHaveLength(4);
    expect(itemKinds(batches[0])).toEqual(['day']); // jan 3, flushed on page 1
    // page batches ride an UNCHANGED cursor: a crash re-detects the deep
    // window (old latest_ts) and re-walks idempotently.
    expect(batches[0].cursor.conversations.C1).toEqual({
      latest_ts: '1701000000.000100',
      name: '#general',
      kind: 'public_channel',
    });
    // completion: jan 2 spans BOTH pages yet renders complete, november day
    // flushes at the end; latest_ts/last_polled advance WITH these items.
    expect(itemKinds(batches[1])).toEqual(['day', 'day']);
    const jan2 = batches[1].items[0];
    if (jan2.kind !== 'day') throw new Error('expected day');
    expect(jan2.day).toBe(DAY2);
    expect(jan2.messages.map((m) => m.ts)).toEqual([mP2a.ts, mP1b.ts]);
    const nov = batches[1].items[1];
    if (nov.kind !== 'day') throw new Error('expected day');
    expect(nov.day).toBe('2023-11-25');
    expect(batches[1].cursor.conversations.C1.latest_ts).toBe(mP1a.ts);
    expect(batches[1].cursor.conversations.C1.last_polled).toBe(
      new Date(NOW_MS).toISOString(),
    );
  });

  it('emits a file shared across two days only once per run (seenFiles dedupe): one item, one download', async () => {
    const msgA: SlackMessage = {
      ts: '1704153700.000100',
      user: 'U1',
      text: 'file on day2',
      files: [F1],
    };
    const msgB: SlackMessage = {
      ts: '1704240800.000100',
      user: 'U2',
      text: 'same file again on day3',
      files: [F1],
    };
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [
          ok({ messages: [] }), // C2
          ok({ messages: [msgB, msgA] }), // C1
        ],
      },
      downloads: { 'https://files.slack.com/F1': F1_BYTES },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const batches = await drain(source.pull(session, liveCursor()));

    // day2 (first sighting) carries the file doc; day3 does not repeat it.
    expect(itemKinds(batches[1])).toEqual(['day', 'file', 'day']);
    expect(calls.filter((c) => c.method === 'download')).toHaveLength(1);
  });

  it('refreshes membership on polls % 10 === 1: prunes left channels (and their threads), mini-backfills newly joined ones', async () => {
    const mC3: SlackMessage = { ts: '1704240650.000100', user: 'U1', text: 'new channel msg' };
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.list': [
          ok({
            channels: [
              { id: 'C2', name: 'dev', is_member: true },
              { id: 'C3', name: 'fresh', is_member: true },
            ],
          }),
        ],
        'conversations.history': [
          ok({ messages: [mC3] }), // C3 mini-backfill walk (no oldest)
          ok({ messages: [] }), // C3 poll
          ok({ messages: [] }), // C2 poll
        ],
      },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const cursor = liveCursor({
      polls: 0, // 0+1 = 1 → refresh (matches the post-backfill floor)
      active_threads: [
        { channel: 'C1', thread_ts: ROOT_TS, last_reply_ts: '1704240550.000200' },
      ],
      conversations: {
        C1: { latest_ts: '1704240600.000100', name: '#general', kind: 'public_channel' },
        C2: {
          latest_ts: '1704326400.000100',
          name: '#dev',
          kind: 'public_channel',
          last_polled: '2024-01-04T00:00:00.000Z',
        },
      },
    });
    const batches = await drain(source.pull(session, cursor));

    expect(calls.filter((c) => c.method === 'conversations.list')).toHaveLength(1);
    const history = calls.filter((c) => c.method === 'conversations.history');
    // mini-backfill walk has NO oldest; the subsequent polls do.
    expect(history.map((c) => [c.params.channel, 'oldest' in c.params])).toEqual([
      ['C3', false],
      ['C3', true],
      ['C2', true],
    ]);

    // C3's completion batch carries its items and installs the conversation.
    const c3Batch = batches[0];
    expect(itemKinds(c3Batch)).toEqual(['day']);
    expect(c3Batch.cursor.conversations.C3).toEqual({
      latest_ts: mC3.ts,
      name: '#fresh',
      kind: 'public_channel',
    });
    // C1 (no longer listed) is pruned along with its active thread.
    expect(c3Batch.cursor.conversations.C1).toBeUndefined();
    expect(c3Batch.cursor.active_threads).toEqual([]);

    const last = batches.at(-1)!;
    expect(Object.keys(last.cursor.conversations).sort()).toEqual(['C2', 'C3']);
    expect(last.cursor.polls).toBe(1);
  });

  it('drops a conversation (and its threads) from the cursor on DROP_CODES and keeps polling the rest', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [
          { ok: false, error: 'channel_not_found' }, // C2 gone
          ok({ messages: [] }), // C1 still polls fine
        ],
      },
    };
    const { fetchFn } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const cursor = liveCursor({
      active_threads: [
        { channel: 'C2', thread_ts: '1704240000.000100', last_reply_ts: '1704240001.000100' },
      ],
    });
    const batches = await drain(source.pull(session, cursor));

    // the drop batch carries the pruned cursor (no items — nothing advanced)
    expect(batches[0].items).toEqual([]);
    expect(batches[0].cursor.conversations.C2).toBeUndefined();
    expect(batches[0].cursor.active_threads).toEqual([]);
    // C1 was still polled afterwards
    const last = batches.at(-1)!;
    expect(Object.keys(last.cursor.conversations)).toEqual(['C1']);
  });

  it('advances an active thread only in the batch carrying its re-rendered doc; expired threads drop; a new root enters at last_reply_ts 0', async () => {
    const rootMsg: SlackMessage = {
      ts: '1704240900.000100',
      user: 'U1',
      text: 'fresh root',
      thread_ts: '1704240900.000100',
      reply_count: 1,
      latest_reply: '1704240910.000100',
    };
    const newReply: SlackMessage = {
      ts: '1704240910.000100',
      thread_ts: '1704240900.000100',
      user: 'U2',
      text: 'fresh reply',
    };
    const oldThreadTs = '1702000000.000100'; // 2023-12-08 — outside the 14d window
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [ok({ messages: [rootMsg] })], // C1 poll
        'conversations.replies': [
          // probe of the stale thread (first in the cursor) — nothing fresh
          ok({ messages: [] }),
          // probe of the NEW root (oldest '0') sees everything as fresh
          ok({ messages: [rootMsg, newReply] }),
          // full-thread re-fetch
          ok({ messages: [rootMsg, newReply] }),
        ],
      },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const cursor: SlackCursor = {
      conversations: {
        C1: { latest_ts: '1704240600.000100', name: '#general', kind: 'public_channel' },
      },
      active_threads: [
        { channel: 'C1', thread_ts: oldThreadTs, last_reply_ts: oldThreadTs },
      ],
      polls: 3,
    };
    const batches = await drain(source.pull(session, cursor));

    // channel batch: no day items (the root is thread territory), but the new
    // root registered at last_reply_ts '0'.
    const newThread: ActiveThread = {
      channel: 'C1',
      thread_ts: rootMsg.ts,
      last_reply_ts: '0',
    };
    expect(batches[0].items).toEqual([]);
    expect(batches[0].cursor.active_threads).toContainEqual(newThread);

    // probes: stale thread from its own ts, then the new root from '0'.
    const replies = calls.filter((c) => c.method === 'conversations.replies');
    expect(replies.map((c) => c.params.oldest)).toEqual([
      oldThreadTs,
      '0',
      undefined, // the full-thread re-fetch has no oldest
    ]);

    // the thread's batch carries the re-rendered doc AND the advanced cursor.
    const threadBatch = batches[1];
    expect(itemKinds(threadBatch)).toEqual(['thread']);
    const item = threadBatch.items[0];
    if (item.kind !== 'thread') throw new Error('expected thread');
    expect(item.messages.map((m) => m.text)).toEqual(['fresh root', 'fresh reply']);
    expect(threadBatch.cursor.active_threads).toContainEqual({
      ...newThread,
      last_reply_ts: newReply.ts,
    });

    // final cursor: fresh thread kept, expired one dropped.
    const last = batches.at(-1)!;
    expect(last.cursor.active_threads).toEqual([
      { ...newThread, last_reply_ts: newReply.ts },
    ]);
  });

  it('drops an active thread on DROP_CODES from the replies probe, keeping its channel', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [ok({ messages: [] })], // C1 poll
        'conversations.replies': [{ ok: false, error: 'not_in_channel' }],
      },
    };
    const { fetchFn } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const cursor: SlackCursor = {
      conversations: {
        C1: { latest_ts: '1704240600.000100', name: '#general', kind: 'public_channel' },
      },
      active_threads: [
        { channel: 'C1', thread_ts: ROOT_TS, last_reply_ts: '1704240550.000200' },
      ],
      polls: 3,
    };
    const batches = await drain(source.pull(session, cursor));

    // the probe's drop-code drops ONLY the thread; the channel stays polled.
    const last = batches.at(-1)!;
    expect(last.cursor.active_threads).toEqual([]);
    expect(Object.keys(last.cursor.conversations)).toEqual(['C1']);
  });

  it('stops polling channels when the request budget is spent, keeping unprobed threads untouched', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [ok({ messages: [] })], // only C2 fits
      },
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn, 2); // users.list + one history call
    const session = makeSession(CREDS);

    const thread: ActiveThread = {
      channel: 'C1',
      thread_ts: ROOT_TS,
      last_reply_ts: '1704240550.000200',
    };
    const batches = await drain(source.pull(session, liveCursor({ active_threads: [thread] })));

    const history = calls.filter((c) => c.method === 'conversations.history');
    expect(history.map((c) => c.params.channel)).toEqual(['C2']);
    expect(calls.filter((c) => c.method === 'conversations.replies')).toHaveLength(0);
    // the unpolled channel keeps its OLD stamp and the unprobed thread survives
    const last = batches.at(-1)!;
    expect(last.cursor.conversations.C1.last_polled).toBe('2024-01-04T00:00:00.000Z');
    expect(last.cursor.active_threads).toEqual([thread]);
  });

  it('propagates auth errors from delta with the reconnect suffix', async () => {
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [{ ok: false, error: 'token_revoked' }],
      },
    };
    const { fetchFn } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    await expect(drain(source.pull(session, liveCursor()))).rejects.toThrow(
      /token_revoked — reconnect the account$/,
    );
  });

  it('emits an oversize file with NO bytes (too_large) without downloading, and skips a file whose download fails', async () => {
    const big = {
      id: 'FBIG',
      name: 'huge.mov',
      mimetype: 'video/quicktime',
      size: 60 * 1024 * 1024,
      url_private: 'https://files.slack.com/FBIG',
    };
    const broken = {
      id: 'FBROKEN',
      name: 'gone.png',
      mimetype: 'image/png',
      size: 10,
      url_private: 'https://files.slack.com/FBROKEN',
    };
    const msg: SlackMessage = {
      ts: '1704240800.000100',
      user: 'U1',
      text: 'attachments',
      files: [big, broken],
    };
    const script: SlackScript = {
      methods: {
        'users.list': [usersPage()],
        'conversations.history': [ok({ messages: [] }), ok({ messages: [msg] })],
      },
      downloads: {}, // FBROKEN's download 404s
    };
    const { fetchFn, calls } = fakeSlack(script);
    const source = makeSource(fetchFn);
    const warnings: string[] = [];
    const session = makeSession(CREDS, warnings);

    const batches = await drain(source.pull(session, liveCursor()));

    const c1Batch = batches[1];
    expect(itemKinds(c1Batch)).toEqual(['day', 'file']);
    const fileItem = c1Batch.items[1];
    if (fileItem.kind !== 'file') throw new Error('expected file');
    expect(fileItem.id).toBe('FBIG');
    expect(fileItem.bytes).toBeUndefined();
    // the oversize file was never downloaded; the broken one was attempted once
    expect(calls.filter((c) => c.method === 'download').map((c) => c.params.url)).toEqual([
      'https://files.slack.com/FBROKEN',
    ]);
    expect(warnings.some((w) => w.includes('FBROKEN'))).toBe(true);
  });
});

describe('toDocument (pure)', () => {
  const source = makeSource(async () => {
    throw new Error('toDocument must never touch the network');
  });

  it('maps a day item to a complete slack.day document', () => {
    const doc = source.toDocument({
      kind: 'day',
      channelId: 'C1',
      channelName: '#general',
      convKind: 'public_channel',
      day: DAY2,
      teamUrl: 'https://acme.slack.com/',
      messages: [
        { ts: '1704153650.000100', userName: 'Bob B', text: 'day2 older', fileIds: [] },
        { ts: '1704153700.000100', userName: 'alice', text: 'day2 with file', fileIds: ['F1'] },
      ],
    }) as DocumentInput;

    expect(doc).toEqual({
      externalId: `C1:${DAY2}`,
      type: 'slack.day',
      title: `#general — ${DAY2}`,
      markdown: [
        `# #general — ${DAY2}`,
        '---',
        '**Bob B** · 2024-01-02 00:00\n\nday2 older',
        '**alice** · 2024-01-02 00:01\n\nday2 with file',
      ].join('\n\n'),
      url: 'https://acme.slack.com/archives/C1/p1704153650000100',
      metadata: {
        slack_channel_id: 'C1',
        slack_channel_name: '#general',
        conversation_type: 'public_channel',
        message_count: 2,
        participants: ['Bob B', 'alice'],
        first_message_at: '2024-01-02T00:00:50.000Z',
        last_message_at: '2024-01-02T00:01:40.000Z',
      },
      createdAt: '2024-01-02T00:00:50.000Z',
    });
  });

  it('maps a thread item with the root-derived title (sliced to 80 chars)', () => {
    const longRoot = 'x'.repeat(100);
    const doc = source.toDocument({
      kind: 'thread',
      channelId: 'C1',
      channelName: '#general',
      threadTs: ROOT_TS,
      teamUrl: 'https://acme.slack.com/',
      messages: [
        { ts: ROOT_TS, userName: 'Bob B', text: longRoot, fileIds: [] },
        { ts: '1704240550.000200', userName: 'alice', text: 'a reply', fileIds: [] },
      ],
    }) as DocumentInput;

    expect(doc.externalId).toBe(`C1:${ROOT_TS}`);
    expect(doc.type).toBe('slack.thread');
    expect(doc.title).toBe(`#general: ${'x'.repeat(80)}`);
    expect(doc.url).toBe('https://acme.slack.com/archives/C1/p1704240500000100');
    expect(doc.markdown).toContain('# #general — thread');
    expect(doc.markdown).toContain('> 2 messages · 2024-01-03 00:08 → 2024-01-03 00:09');
    expect(doc.metadata).toMatchObject({
      slack_thread_ts: ROOT_TS,
      message_count: 2,
      participants: ['Bob B', 'alice'],
    });
    expect(doc.createdAt).toBe('2024-01-03T00:08:20.000Z');
  });

  it('maps file items: bytes → binary doc; no bytes → too_large metadata, no binary', () => {
    const base = {
      kind: 'file' as const,
      id: 'F1',
      filename: 'notes.pdf',
      mime: 'application/pdf',
      sizeBytes: 5,
      urlPrivate: 'https://files.slack.com/F1',
      channelId: 'C1',
      ts: '1704153700.000100',
      parentExternalId: `C1:${DAY2}`,
      parentType: 'slack.day',
    };

    const withBytes = source.toDocument({ ...base, bytes: F1_BYTES }) as DocumentInput;
    expect(withBytes).toEqual({
      externalId: 'F1',
      type: 'file',
      title: 'notes.pdf',
      markdown: null,
      binary: { bytes: F1_BYTES, mime: 'application/pdf', filename: 'notes.pdf' },
      metadata: {
        filename: 'notes.pdf',
        mime_type: 'application/pdf',
        size_bytes: 5,
        url_private: 'https://files.slack.com/F1',
        slack_channel_id: 'C1',
      },
      parent: { externalId: `C1:${DAY2}`, type: 'slack.day' },
      createdAt: '2024-01-02T00:01:40.000Z',
    });

    const tooLarge = source.toDocument({
      ...base,
      sizeBytes: 60 * 1024 * 1024,
    }) as DocumentInput;
    expect(tooLarge.binary).toBeUndefined();
    expect(tooLarge.metadata.extraction_status).toBe('too_large');
  });

  it('returns null for an empty day (nothing indexable survived)', () => {
    expect(
      source.toDocument({
        kind: 'day',
        channelId: 'C1',
        channelName: '#general',
        convKind: 'public_channel',
        day: DAY2,
        teamUrl: 'https://acme.slack.com/',
        messages: [],
      }),
    ).toBeNull();
  });
});

describe('fetchBytes', () => {
  const doc = (metadata: Record<string, unknown>) =>
    ({ metadata }) as unknown as import('../kiagent-contracts').Document;

  it('re-downloads via metadata.url_private with the vault token', async () => {
    const { fetchFn, calls } = fakeSlack({
      downloads: { 'https://files.slack.com/F1': F1_BYTES },
    });
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    const bytes = await source.fetchBytes!(
      session,
      doc({ url_private: 'https://files.slack.com/F1', size_bytes: 5 }),
    );

    expect(bytes).toEqual(F1_BYTES);
    expect(calls).toHaveLength(1);
  });

  it('returns null for oversize files, missing urls, and failed downloads', async () => {
    const { fetchFn } = fakeSlack({ downloads: {} });
    const source = makeSource(fetchFn);
    const session = makeSession(CREDS);

    await expect(
      source.fetchBytes!(session, doc({ url_private: 'https://files.slack.com/F9', size_bytes: 60 * 1024 * 1024 })),
    ).resolves.toBeNull();
    await expect(source.fetchBytes!(session, doc({}))).resolves.toBeNull();
    await expect(
      source.fetchBytes!(session, doc({ url_private: 'https://files.slack.com/F9', size_bytes: 5 })),
    ).resolves.toBeNull();
  });
});

describe('reconcile', () => {
  it('is deliberately absent (channel-level pruning is cursor-only)', () => {
    const source = makeSource(async () => {
      throw new Error('unused');
    });
    expect(source.reconcile).toBeUndefined();
  });
});
