/**
 * v1 had no client.test.ts (client.ts was untested there); this suite is new
 * for the v2 port. Fetch is fully scripted (no real network), and `sleep` is
 * recorded rather than awaited for real — a fake clock advances only when
 * `sleep` is invoked, so throttle/backoff math is exact and the suite runs
 * instantly.
 */
import { SlackApiError, SlackClient, isAuthError, type NetFetch } from '../client';

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

function makeClient(
  fetchFn: NetFetch,
  extra: { requestsPerMinute?: number; maxTransientRetries?: number } = {},
) {
  const sleeps: number[] = [];
  let clock = 10_000_000; // arbitrary starting point >> WINDOW_MS
  const client = new SlackClient({
    fetch: fetchFn,
    token: 'xoxp-test-deadbeef',
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms; // model sleep as elapsed time for throttle math
    },
    now: () => clock,
    ...extra,
  });
  return { client, sleeps };
}

describe('SlackClient.call', () => {
  it('POSTs form-encoded params with the bearer token to slack.com/api/<method>', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: unknown) =>
      jsonResponse(200, { ok: true, channel: 'C1' }),
    );
    const { client } = makeClient(fetchFn);

    const result = await client.call('conversations.history', {
      channel: 'C1',
      limit: 999,
      cursor: undefined, // undefined params must be omitted
    });

    expect(result).toEqual({ ok: true, channel: 'C1' });
    const [url, init] = fetchFn.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://slack.com/api/conversations.history');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer xoxp-test-deadbeef');
    expect(init.headers['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.body).toBe('channel=C1&limit=999');
  });

  it('enforces the sliding-window rpm budget: request N+1 waits out the window', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(200, { ok: true }));
    const { client, sleeps } = makeClient(fetchFn, { requestsPerMinute: 2 });

    await client.call('conversations.history', {});
    await client.call('conversations.history', {});
    expect(sleeps).toEqual([]); // first two fit the window

    await client.call('conversations.history', {});
    expect(sleeps).toEqual([60_000]); // third waits for the oldest stamp to expire
  });

  it('spaces Tier-2 methods (users.list / conversations.list) 3s apart per method', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(200, { ok: true }));
    const { client, sleeps } = makeClient(fetchFn);

    await client.call('users.list', { limit: 200 });
    await client.call('conversations.history', {}); // tier 3 — no spacing
    expect(sleeps).toEqual([]);

    await client.call('users.list', { limit: 200 });
    expect(sleeps).toEqual([3_000]);
  });

  it('retries a 429 honoring retry-after, then returns the successful result', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, {}, { 'retry-after': '2' });
      return jsonResponse(200, { ok: true, done: true });
    });
    const { client, sleeps } = makeClient(fetchFn);

    const result = await client.call('conversations.history', {});

    expect(sleeps).toEqual([2_000]);
    expect(result).toEqual({ ok: true, done: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('clamps retry-after into [1,60]s and defaults to 5s when missing', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, {}, { 'retry-after': '999' });
      if (call === 2) return jsonResponse(429, {}); // missing header
      if (call === 3) return jsonResponse(429, {}, { 'retry-after': '0' });
      return jsonResponse(200, { ok: true });
    });
    const { client, sleeps } = makeClient(fetchFn);

    await client.call('conversations.history', {});

    expect(sleeps).toEqual([60_000, 5_000, 1_000]);
  });

  it('gives up after 5 rate-limit retries', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(429, {}, { 'retry-after': '1' }),
    );
    const { client, sleeps } = makeClient(fetchFn);

    await expect(client.call('users.list', {})).rejects.toThrow(
      /HTTP 429 after 6 attempts/,
    );
    expect(sleeps.filter((s) => s === 1_000)).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('retries thrown network errors with exponential backoff 2s/4s/8s/16s, then throws', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const { client, sleeps } = makeClient(fetchFn);

    await expect(client.call('conversations.history', {})).rejects.toThrow(
      /network error after 5 attempts: ECONNRESET/,
    );
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('retries 5xx with the same transient backoff, then succeeds', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call <= 2) return jsonResponse(503, {});
      return jsonResponse(200, { ok: true });
    });
    const { client, sleeps } = makeClient(fetchFn);

    const result = await client.call('conversations.history', {});

    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  // maxTransientRetries exists for NON-IDEMPOTENT writes (chat.postMessage
  // has no idempotency key): a retried network failure that Slack had already
  // accepted would double-post. It governs the transient paths ONLY.
  it('maxTransientRetries: 0 disables 5xx retries — one attempt, no sleep', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(503, {}));
    const { client, sleeps } = makeClient(fetchFn, { maxTransientRetries: 0 });

    await expect(client.call('chat.postMessage', {})).rejects.toThrow(
      /HTTP 503/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('maxTransientRetries: 0 disables network-throw retries too', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const { client, sleeps } = makeClient(fetchFn, { maxTransientRetries: 0 });

    await expect(client.call('chat.postMessage', {})).rejects.toThrow(
      /ECONNRESET/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('maxTransientRetries: 0 leaves the 429 ladder intact (rate limits cannot duplicate a write)', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, {}, { 'retry-after': '2' });
      return jsonResponse(200, { ok: true, ts: '1.2' });
    });
    const { client, sleeps } = makeClient(fetchFn, { maxTransientRetries: 0 });

    expect(await client.call('chat.postMessage', {})).toEqual({
      ok: true,
      ts: '1.2',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
  });

  it('defaults to the full 4-retry transient ladder when the knob is omitted', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call <= 4) return jsonResponse(500, {});
      return jsonResponse(200, { ok: true });
    });
    const { client, sleeps } = makeClient(fetchFn);

    expect(await client.call('conversations.history', {})).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('throws plain Error on unexpected non-2xx status (no retry)', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(404, {}));
    const { client } = makeClient(fetchFn);

    await expect(client.call('conversations.history', {})).rejects.toThrow(
      'slack conversations.history: HTTP 404',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps an ok:false envelope to SlackApiError; auth codes carry code=401', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, { ok: false, error: 'invalid_auth' }),
    );
    const { client } = makeClient(fetchFn);

    let error: unknown;
    try {
      await client.call('auth.test', {});
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(SlackApiError);
    expect((error as SlackApiError).slackError).toBe('invalid_auth');
    expect((error as SlackApiError).code).toBe(401);
    expect(isAuthError(error)).toBe(true);
  });

  it('non-auth envelope errors carry no 401 code (isAuthError false)', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, { ok: false, error: 'channel_not_found' }),
    );
    const { client } = makeClient(fetchFn);

    let error: unknown;
    try {
      await client.call('conversations.history', { channel: 'C9' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(SlackApiError);
    expect((error as SlackApiError).code).toBeUndefined();
    expect(isAuthError(error)).toBe(false);
  });
});

describe('SlackClient.pages', () => {
  it('follows response_metadata.next_cursor to exhaustion and resumes from startCursor', async () => {
    const pages = [
      { ok: true, messages: ['b'], response_metadata: { next_cursor: 'c3' } },
      { ok: true, messages: ['c'], response_metadata: { next_cursor: '' } },
    ];
    let call = 0;
    const seenCursors: Array<string | undefined> = [];
    const fetchFn = jest.fn(async (_url: string, init?: unknown) => {
      const { body } = init as { body: string };
      seenCursors.push(
        new URLSearchParams(body).get('cursor') ?? undefined,
      );
      const page = pages[call];
      call += 1;
      return jsonResponse(200, page);
    });
    const { client } = makeClient(fetchFn);

    const collected: unknown[] = [];
    for await (const page of client.pages('conversations.history', {
      channel: 'C1',
    }, 'c2')) {
      collected.push((page as { messages?: unknown[] }).messages);
    }

    expect(collected).toEqual([['b'], ['c']]);
    // startCursor rides the FIRST request (mid-walk resume), then follows.
    expect(seenCursors).toEqual(['c2', 'c3']);
  });
});

describe('SlackClient.download', () => {
  it('GETs the url with bearer auth and returns the raw bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchFn = jest.fn(async () => ({
      status: 200,
      statusText: '',
      headers: {},
      body: bytes,
    }));
    const { client } = makeClient(fetchFn);

    const out = await client.download('https://files.slack.com/F1');

    expect(out).toBe(bytes);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://files.slack.com/F1');
    expect(init.headers.authorization).toBe('Bearer xoxp-test-deadbeef');
  });

  it('throws on a non-2xx download status', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(404, {}));
    const { client } = makeClient(fetchFn);

    await expect(client.download('https://files.slack.com/F1')).rejects.toThrow(
      'slack file download: HTTP 404',
    );
  });
});
