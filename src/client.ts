import { setTimeout as nodeSleep } from 'node:timers/promises';

export const SLACK_API_BASE = 'https://slack.com/api';
/** Conservative Tier 3 budget (posted limit ~50/min for internal apps). */
export const REQUESTS_PER_MINUTE = 45;
const WINDOW_MS = 60_000;
/** conversations.list / users.list are Tier 2 (~20/min) — extra spacing. */
const TIER2_METHODS = new Set(['conversations.list', 'users.list']);
const TIER2_MIN_INTERVAL_MS = 3_000;
/** A backfill makes tens of thousands of consecutive calls (a single giant
 *  channel can need 20k+ conversations.replies), so transient 5xx/network
 *  blips are a statistical certainty over its lifetime — retry them with
 *  exponential backoff instead of aborting hours of work. */
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = 2_000; // 2s, 4s, 8s, 16s
const MAX_RATE_LIMIT_RETRIES = 5;

/** Slack error codes meaning the token is dead or under-scoped. code=401 makes
 *  the scheduler's isAuthError() flag the account needs_reauth. */
const AUTH_ERROR_CODES = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'not_authed',
  'missing_scope',
]);

export class SlackApiError extends Error {
  readonly code?: number;

  constructor(
    readonly slackError: string,
    method: string,
  ) {
    super(`slack ${method}: ${slackError}`);
    this.name = 'SlackApiError';
    if (AUTH_ERROR_CODES.has(slackError)) this.code = 401;
  }
}

export interface SlackClientDeps {
  getToken: () => string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  requestsPerMinute?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

export class SlackClient {
  /** Requests issued over this client's lifetime (delta budget accounting). */
  requestCount = 0;

  private stamps: number[] = [];

  private lastByMethod = new Map<string, number>();

  private readonly fetchFn: typeof fetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly now: () => number;

  private readonly rpm: number;

  constructor(private readonly deps: SlackClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn = deps.sleepFn ?? (async (ms) => void (await nodeSleep(ms)));
    this.now = deps.nowFn ?? Date.now;
    this.rpm = deps.requestsPerMinute ?? REQUESTS_PER_MINUTE;
  }

  private async acquire(method: string): Promise<void> {
    for (;;) {
      const now = this.now();
      this.stamps = this.stamps.filter((t) => now - t < WINDOW_MS);
      const t2 = TIER2_METHODS.has(method)
        ? this.lastByMethod.get(method)
        : undefined;
      const tier2Wait = t2 === undefined ? 0 : t2 + TIER2_MIN_INTERVAL_MS - now;
      const bucketWait =
        this.stamps.length < this.rpm ? 0 : this.stamps[0] + WINDOW_MS - now;
      const wait = Math.max(tier2Wait, bucketWait);
      if (wait <= 0) break;
      await this.sleepFn(wait);
    }
    const t = this.now();
    this.stamps.push(t);
    this.lastByMethod.set(method, t);
    this.requestCount += 1;
  }

  async call<T extends SlackEnvelope = SlackEnvelope>(
    method: string,
    params: Params = {},
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body.set(k, String(v));
    }
    let transient = 0;
    let rateLimited = 0;
    for (;;) {
      await this.acquire(method);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await this.fetchFn(`${SLACK_API_BASE}/${method}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.deps.getToken()}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(
            `slack ${method}: network error after ${transient + 1} attempts: ${msg}`,
          );
        transient += 1;
        const wait = TRANSIENT_BACKOFF_MS * 2 ** (transient - 1);
        console.warn(
          `[slack] ${method} network error (retry ${transient}/${MAX_TRANSIENT_RETRIES} in ${wait / 1000}s): ${msg}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await this.sleepFn(wait);
        continue;
      }
      if (res.status === 429) {
        if (rateLimited >= MAX_RATE_LIMIT_RETRIES)
          throw new Error(
            `slack ${method}: HTTP 429 after ${rateLimited + 1} attempts`,
          );
        rateLimited += 1;
        // Retry-After may be missing or a non-numeric HTTP-date; both must not
        // collapse to a 0ms busy-retry. Default to 5s, floor 1s, cap 60s.
        const raw = Number(res.headers.get('retry-after'));
        const after = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 60) : 5;
        // eslint-disable-next-line no-await-in-loop
        await this.sleepFn(after * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(
            `slack ${method}: HTTP ${res.status} (after ${transient + 1} attempts)`,
          );
        transient += 1;
        const wait = TRANSIENT_BACKOFF_MS * 2 ** (transient - 1);
        console.warn(
          `[slack] ${method} HTTP ${res.status} (retry ${transient}/${MAX_TRANSIENT_RETRIES} in ${wait / 1000}s)`,
        );
        // eslint-disable-next-line no-await-in-loop
        await this.sleepFn(wait);
        continue;
      }
      if (!res.ok) throw new Error(`slack ${method}: HTTP ${res.status}`);
      // eslint-disable-next-line no-await-in-loop
      const json = (await res.json()) as T;
      if (!json.ok)
        throw new SlackApiError(json.error ?? 'unknown_error', method);
      return json;
    }
  }

  /** Iterate a cursor-paginated method, yielding each page. `startCursor`
   *  resumes pagination mid-walk (intra-channel backfill checkpoint). */
  async *pages<T extends SlackEnvelope = SlackEnvelope>(
    method: string,
    params: Params,
    startCursor?: string,
  ): AsyncGenerator<T> {
    let cursor: string | undefined = startCursor;
    do {
      const page = await this.call<T>(method, { ...params, cursor });
      yield page;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  /** Download a url_private file with bearer auth. */
  async download(url: string): Promise<Buffer> {
    await this.acquire('files.download');
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.deps.getToken()}` },
    });
    if (!res.ok) throw new Error(`slack file download: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
