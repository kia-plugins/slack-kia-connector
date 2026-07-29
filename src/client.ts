/**
 * v2 port of v1 `src/client.ts` (see `git show main:src/client.ts` in this
 * repo). Preserved verbatim: API base, the 45 req/min sliding window, the 3s
 * Tier-2 spacing (conversations.list / users.list), 429 handling (Retry-After
 * clamp [1,60]s, default 5s, ≤5 retries), transient network/5xx exponential
 * backoff (2s × 2^n, ≤4 retries), SlackApiError with 401 tagging for auth
 * error codes, the resumable `pages()` paginator, and bearer `download()`.
 *
 * Deltas from v1:
 *  1. All I/O goes through `deps.fetch` — the host's `net.fetch` surface —
 *     NEVER the global fetch. The host resolves to a plain object
 *     (status / statusText / headers with lowercase keys / body: Uint8Array),
 *     so responses are parsed manually and `.ok` is computed from `status`.
 *  2. Token is a constructor dep (one client instance per pull) — v1 read it
 *     via getToken().
 *  3. Retry warnings no longer go to console — the client is silent; callers
 *     log through session.log.
 *
 * The transient/429 retry ladder that used to live inline in `call()` now
 * comes from `@kiagent/connector-sdk/http` — the SDK's `requestWithRetry` was
 * extracted verbatim FROM this file, so budgets (4 transient / 5 rate-limit),
 * backoff base (2s × 2^n) and the Retry-After clamp ([1,60]s, default 5s) are
 * its defaults and no longer need restating here. What stays local is
 * everything Slack-specific: the rate window (acquired inside `attempt`, so it
 * runs before EVERY try including retries), the bearer/form request shape, and
 * all status/envelope classification after the ladder returns.
 */
import {
  requestWithRetry,
  type HostResponse,
  type NetFetch,
} from '@kiagent/connector-sdk/http';

/** Re-exported (erased at build time) so source.ts / sender.ts and the suites
 *  keep importing the host-fetch shapes from the client they use them with. */
export type { HostResponse, NetFetch };

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
 *  exponential backoff instead of aborting hours of work. Matches the SDK
 *  ladder's own default; kept explicit because it is this client's documented
 *  contract with its callers (`maxTransientRetries`). */
const MAX_TRANSIENT_RETRIES = 4;

/** Slack error codes meaning the token is dead or under-scoped. code=401 lets
 *  callers (isAuthError) tell "reconnect the account" apart from transient
 *  per-channel failures. */
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

/** Token dead / revoked / under-scoped — every later call would fail the same
 *  way, so these always PROPAGATE out of pull. */
export const isAuthError = (e: unknown): boolean =>
  e instanceof SlackApiError && e.code === 401;

export interface SlackClientDeps {
  fetch: NetFetch;
  token: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requestsPerMinute?: number;
  /** Retries for TRANSIENT network/5xx failures only (default 4). Reads want
   *  the full ladder; a NON-IDEMPOTENT write does not — chat.postMessage has
   *  no idempotency key, so a network failure AFTER Slack accepted the write
   *  would double-post on retry. Senders pass 0. The 429 ladder is unaffected
   *  at any setting: Slack rejects a rate-limited call before processing it,
   *  so retrying it cannot duplicate anything. */
  maxTransientRetries?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

export interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

export class SlackClient {
  /** Requests issued over this client's lifetime (delta budget accounting). */
  requestCount = 0;

  private stamps: number[] = [];

  private lastByMethod = new Map<string, number>();

  private readonly fetchFn: NetFetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly now: () => number;

  private readonly rpm: number;

  private readonly maxTransient: number;

  constructor(private readonly deps: SlackClientDeps) {
    this.fetchFn = deps.fetch;
    this.sleepFn =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.rpm = deps.requestsPerMinute ?? REQUESTS_PER_MINUTE;
    this.maxTransient = deps.maxTransientRetries ?? MAX_TRANSIENT_RETRIES;
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
    // The rate window is acquired INSIDE attempt(), not around the ladder: a
    // retry is a new request against Slack's budget, so it must wait its turn
    // exactly like a first try.
    const res = await requestWithRetry(
      async () => {
        await this.acquire(method);
        return (await this.fetchFn(`${SLACK_API_BASE}/${method}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.deps.token}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        })) as HostResponse;
      },
      {
        // `slack ${method}` reproduces this client's historical message
        // prefixes verbatim — the suites pin them.
        label: `slack ${method}`,
        maxTransientRetries: this.maxTransient,
        sleep: this.sleepFn,
      },
    );
    // The ladder RETURNS every non-429/<500 status; classifying them is ours.
    if (res.status < 200 || res.status >= 300)
      throw new Error(`slack ${method}: HTTP ${res.status}`);
    const json = JSON.parse(new TextDecoder().decode(res.body)) as T;
    if (!json.ok) throw new SlackApiError(json.error ?? 'unknown_error', method);
    return json;
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

  /** Download a url_private file with bearer auth.
   *
   *  Deliberately NOT on the retry ladder: it has never retried anything, and
   *  routing it through `requestWithRetry` would both add 5xx/429 retries it
   *  never had and rewrite its 429 message (`… HTTP 429 after 1 attempts`
   *  instead of `… HTTP 429`). One attempt, one status check — unchanged. */
  async download(url: string): Promise<Uint8Array> {
    await this.acquire('files.download');
    const res = (await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.deps.token}` },
    })) as HostResponse;
    if (res.status < 200 || res.status >= 300)
      throw new Error(`slack file download: HTTP ${res.status}`);
    return res.body;
  }
}
