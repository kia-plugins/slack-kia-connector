/**
 * Sender suite: chat.postMessage into the channel/thread the source document
 * came from. `host.net.fetch` is scripted — no real network — and every case
 * stays on a NON-retrying client path (HTTP 200 + an envelope), so the
 * client's real 2s/4s/8s backoff timers never fire in the suite.
 *
 * The two credential/scope refusals must keep their `reconnect the account in
 * Settings` tail: core's outbound error classifier keys off it (AUTH_MARKERS)
 * to render the draft as re-authable rather than as a hard failure.
 */
import { createSlackSender } from '../sender';
import type { NetFetch } from '../client';
import type { HostFor, SendIntent, SenderContext } from '@kiagent/connector-sdk';

/** Local copies of source.test.ts's helpers — that suite doesn't export them. */
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

function makeHost(fetchFn: NetFetch): HostFor<'net' | 'send'> {
  return {
    self: { id: 'slack', dataDir: '/tmp' },
    log: () => {},
    net: { fetch: fetchFn },
  };
}

interface RecordedCall {
  method: string;
  params: Record<string, string>;
}

interface ScriptedResponse {
  /** HTTP status (default 200). */
  status?: number;
  /** Envelope body (default `{ ok: true }`). */
  json?: unknown;
  headers?: Record<string, string>;
}

/** Scripted Slack Web API: a FIFO queue of responses, recording the method +
 *  decoded form params of every request in order. */
function fakeSlack(script: ScriptedResponse[]) {
  const queue = [...script];
  const calls: RecordedCall[] = [];
  const fetchFn: NetFetch = async (url, init) => {
    const method = url.slice('https://slack.com/api/'.length);
    const i = (init ?? {}) as { body?: string };
    const params = Object.fromEntries(new URLSearchParams(i.body ?? ''));
    calls.push({ method, params });
    const next = queue.shift();
    if (next === undefined)
      throw new Error(
        `fakeSlack: no response queued for ${method} ${JSON.stringify(params)}`,
      );
    return jsonResponse(
      next.status ?? 200,
      next.json ?? { ok: true },
      next.headers ?? {},
    );
  };
  return { fetchFn, calls };
}

const THREAD_TS = '1704067200.000100';

function makeIntent(over: Partial<SendIntent> = {}): SendIntent {
  return {
    accountId: 'acc1',
    kind: 'reply',
    // Exactly what the host round-trips from metadata.outbound.ref.
    outboundRef: { channel: 'C1', thread_ts: THREAD_TS },
    bodyMarkdown: 'on it — shipping today',
    ...over,
  };
}

const withToken = (token: string): SenderContext => ({
  credentials: { password: token },
});

describe('slack sender', () => {
  it('posts the draft into the thread the document came from and returns the message ts', async () => {
    const { fetchFn, calls } = fakeSlack([
      { json: { ok: true, channel: 'C1', ts: '1704067300.000200' } },
    ]);
    const sender = createSlackSender(makeHost(fetchFn));

    const res = await sender.send(makeIntent(), withToken('xoxp-abc'));

    expect(calls).toEqual([
      {
        method: 'chat.postMessage',
        params: {
          channel: 'C1',
          thread_ts: THREAD_TS,
          text: 'on it — shipping today',
        },
      },
    ]);
    expect(res.externalMessageId).toBe('1704067300.000200');
  });

  it('posts at channel level (no thread_ts key at all) for a day document', async () => {
    const { fetchFn, calls } = fakeSlack([
      { json: { ok: true, ts: '1704067400.000300' } },
    ]);
    const sender = createSlackSender(makeHost(fetchFn));

    await sender.send(
      makeIntent({ outboundRef: { channel: 'C2' } }),
      withToken('xoxp-abc'),
    );

    // Params DROPS undefined — a literal "undefined" thread_ts would be a
    // bogus parent ts, not a channel-level post.
    expect(calls[0]?.params).toEqual({
      channel: 'C2',
      text: 'on it — shipping today',
    });
  });

  it('refuses without credentials, in words core classifies as auth', async () => {
    const { fetchFn, calls } = fakeSlack([]);
    const sender = createSlackSender(makeHost(fetchFn));

    await expect(
      sender.send(makeIntent(), { credentials: null }),
    ).rejects.toThrow(/reconnect the account in Settings/);
    // ctx is optional on the interface — an absent one refuses identically.
    await expect(sender.send(makeIntent())).rejects.toThrow(
      /reconnect the account in Settings/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a draft whose document carries no reply target, before any network call', async () => {
    const { fetchFn, calls } = fakeSlack([]);
    const sender = createSlackSender(makeHost(fetchFn));

    await expect(
      sender.send(makeIntent({ outboundRef: undefined }), withToken('xoxp-abc')),
    ).rejects.toThrow(/no reply target/);
    await expect(
      sender.send(makeIntent({ outboundRef: {} }), withToken('xoxp-abc')),
    ).rejects.toThrow(/no reply target/);
    expect(calls).toEqual([]);
  });

  it('translates missing_scope into the re-install + reconnect instruction', async () => {
    const { fetchFn } = fakeSlack([{ json: { ok: false, error: 'missing_scope' } }]);
    const sender = createSlackSender(makeHost(fetchFn));

    const err = await sender
      .send(makeIntent(), withToken('xoxp-abc'))
      .then(
        () => new Error('expected a rejection'),
        (e: unknown) => e as Error,
      );

    expect(err.message).toMatch(/chat:write[\s\S]*in Settings/);
    // Shaped for core's AUTH_MARKERS (→ kind 'auth', retryable) — the
    // `chat:write` assertion alone stays green without the word `reconnect`.
    expect(err.message).toMatch(/reconnect .* in Settings/);
  });

  // The other five AUTH_ERROR_CODES are provable PRE-delivery rejections;
  // untranslated they read as "may still have been sent" with no Try again.
  it.each([
    'token_revoked',
    'invalid_auth',
    'account_inactive',
    'token_expired',
    'not_authed',
  ])('translates %s into a dead-token reconnect instruction', async (code) => {
    const { fetchFn } = fakeSlack([{ json: { ok: false, error: code } }]);
    const sender = createSlackSender(makeHost(fetchFn));

    const err = await sender
      .send(makeIntent(), withToken('xoxp-abc'))
      .then(
        () => new Error('expected a rejection'),
        (e: unknown) => e as Error,
      );

    // Shaped for core's AUTH_MARKERS (→ kind 'auth', retryable).
    expect(err.message).toMatch(/reconnect .* in Settings/);
    expect(err.message).toBe(
      `your Slack token no longer works (${code}) — reconnect the account in Settings`,
    );
    // The chat:write copy stays exclusive to missing_scope.
    expect(err.message).not.toMatch(/chat:write/);
  });

  it('propagates a non-auth Slack error unchanged', async () => {
    const { fetchFn } = fakeSlack([
      { json: { ok: false, error: 'channel_not_found' } },
    ]);
    const sender = createSlackSender(makeHost(fetchFn));

    await expect(
      sender.send(makeIntent(), withToken('xoxp-abc')),
    ).rejects.toThrow('slack chat.postMessage: channel_not_found');
  });

  it('does NOT retry a 5xx — a send is not idempotent, so one attempt only', async () => {
    // Two responses queued; a retrying client would consume both.
    const { fetchFn, calls } = fakeSlack([
      { status: 500 },
      { json: { ok: true, ts: 'would-be-a-duplicate' } },
    ]);
    const sender = createSlackSender(makeHost(fetchFn));

    await expect(
      sender.send(makeIntent(), withToken('xoxp-abc')),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry a network throw either', async () => {
    const calls: string[] = [];
    const fetchFn: NetFetch = async (url) => {
      calls.push(url);
      throw new Error('ECONNRESET');
    };
    const sender = createSlackSender(makeHost(fetchFn));

    await expect(
      sender.send(makeIntent(), withToken('xoxp-abc')),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toHaveLength(1);
  });

  it('still retries a 429 — Slack rejects those BEFORE processing, so they cannot duplicate', async () => {
    const { fetchFn, calls } = fakeSlack([
      { status: 429, headers: { 'retry-after': '1' } },
      { json: { ok: true, ts: '1704067500.000400' } },
    ]);
    const sender = createSlackSender(makeHost(fetchFn));

    const res = await sender.send(makeIntent(), withToken('xoxp-abc'));

    expect(res.externalMessageId).toBe('1704067500.000400');
    expect(calls).toHaveLength(2);
    // Real 1s Retry-After sleep: the sender deliberately exposes no sleep seam.
  }, 10_000);
});
