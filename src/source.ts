/**
 * Slack v2 source. Ports v1's proven sync shape (`git show main:src/backfill.ts`
 * / `main:src/delta.ts`) onto the v2 contract:
 *
 *  - connect: paste-token (xoxp-…) via the engine's password-prompt vault,
 *    validated against auth.test + the x-oauth-scopes header.
 *  - backfill: full history walk per member conversation, newest→oldest,
 *    page-aligned resumable via cursor.backfill_progress; one batch per
 *    history page, conversation completion advances backfill_done, and the
 *    walk flips to a final `live` batch when every conversation is done.
 *  - delta: budgeted poll — periodic membership refresh, per-channel history
 *    with a day-start-clamped lookback, then an active-thread replies pass.
 *  - toDocument: PURE (items carry pre-resolved names + pre-rendered mrkdwn).
 *
 * KEY v1→v2 CHANGE — no read-modify-write. v1's appendToChannelDay merged new
 * messages into existing day docs; v2 upserts REPLACE whole documents by
 * externalId, so every emitted day item carries the COMPLETE day's messages
 * (backfill walks whole days by construction; delta clamps its history window
 * down to a local-day boundary — see the comment at the clamp).
 */
import type {
  AuthChannel,
  Batch,
  Document,
  HostFor,
  PullPhase,
  Session,
  Source,
} from './kiagent-contracts';
import {
  SLACK_API_BASE,
  SlackApiError,
  SlackClient,
  isAuthError,
  type HostResponse,
  type NetFetch,
  type SlackEnvelope,
} from './client';
import { SlackUserDirectory } from './users';
import { SourceAuthError } from './kiagent-source-errors';
import {
  MAX_FILE_BYTES,
  dayKey,
  dayToDocument,
  fileToDocument,
  indexable,
  localDayStartTs,
  threadToDocument,
  toRendered,
  tsToDate,
} from './messages';
import type {
  ActiveThread,
  BackfillProgress,
  ConversationKind,
  DayItem,
  FileItem,
  SlackConversation,
  SlackCursor,
  SlackItem,
  SlackMessage,
  ThreadItem,
} from './types';

export const ACTIVE_THREAD_WINDOW_DAYS = 14;
export const DELTA_REQUEST_BUDGET = 40;
export const LIST_REFRESH_EVERY = 10;
/** Re-read this far behind latest_ts so replies turning a recent message into
 *  a thread root are noticed (replies never appear in channel history). */
export const DELTA_LOOKBACK_SECONDS = 86_400;
/** A polled channel whose catch-up window (now − clamped oldest) exceeds this
 *  is re-walked page-aligned instead of drained into one in-memory batch —
 *  `oldest` derives from latest_ts, not now, so a channel dormant for months
 *  (or empty at backfill, latest_ts '0') can hide an unbounded backlog
 *  behind it. */
export const MAX_DRAIN_WINDOW_SECONDS = 7 * 86_400;

/** The scopes the pasted token must carry (the user creates their own
 *  internal Slack app from the manifest in the README — internal apps keep
 *  Tier-3 rate limits, which the backfill depends on). */
export const SLACK_USER_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
  'files:read',
  // Outbound: posting a reply the user confirmed in the app. Every other
  // scope here is read-only; nothing sends without a confirmation gate.
  'chat:write',
];

const SCOPE_LINES = SLACK_USER_SCOPES.map((s) => `        - ${s}`).join('\n');

/** The internal-app manifest the user pastes at api.slack.com — an internal,
 *  customer-built app keeps Slack's standard (non-Marketplace) rate limits;
 *  never bundle OAuth (see README "Connect your workspace"). Shown as a
 *  copyable block in the connect wizard's x-steps. */
export const SLACK_APP_MANIFEST = `display_information:
  name: KIAgent
  description: Personal digital memory indexing (runs locally on your Mac)
oauth_config:
  scopes:
    user:
${SCOPE_LINES}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

/** Kicked out / deleted / archived — drop the conversation from the cursor
 *  and keep polling the rest. */
const DROP_CODES = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
]);

interface HistoryPage extends SlackEnvelope {
  messages?: SlackMessage[];
}

interface ConversationsPage extends SlackEnvelope {
  channels?: SlackConversation[];
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Every yielded cursor is an independent deep copy — the engine commits it
 *  transactionally with the batch, and later mutation must not reach back. */
const snapshot = <T>(v: T): T => structuredClone(v);

export function kindOf(c: SlackConversation): ConversationKind {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  return c.is_private ? 'private_channel' : 'public_channel';
}

export function conversationDisplayName(
  c: SlackConversation,
  resolve: (id?: string) => string,
): string {
  if (c.is_im) return `DM with ${resolve(c.user)}`;
  if (c.is_mpim)
    return `Group DM: ${(c.name ?? '')
      .replace(/^mpdm-/, '')
      .replace(/-\d+$/, '')
      .split('--')
      .join(', ')}`;
  return `#${c.name ?? c.id}`;
}

async function listMemberConversations(
  client: SlackClient,
): Promise<SlackConversation[]> {
  const out: SlackConversation[] = [];
  for await (const page of client.pages<ConversationsPage>(
    'conversations.list',
    {
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 200,
    },
  )) {
    for (const c of page.channels ?? []) {
      if (c.is_im || c.is_mpim || c.is_member) out.push(c);
    }
  }
  return out;
}

async function fetchThread(
  client: SlackClient,
  channel: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  for await (const page of client.pages<HistoryPage>('conversations.replies', {
    channel,
    ts: threadTs,
    limit: 999,
  })) {
    out.push(...(page.messages ?? []));
  }
  const seen = new Set<string>();
  return out
    .filter((m) => !seen.has(m.ts) && Boolean(seen.add(m.ts)))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Everything a pull cycle carries around. */
interface PullCtx {
  client: SlackClient;
  session: Session;
  users: SlackUserDirectory;
  teamUrl: string;
  now: () => number;
  /** File ids already emitted THIS run (the same Slack file can be shared in
   *  several messages) — the first sighting wins. */
  seenFiles: Set<string>;
}

const withinDays = (ctx: PullCtx, ts: string, days: number): boolean =>
  ctx.now() - tsToDate(ts).getTime() < days * 86_400_000;

interface ConvRef {
  id: string;
  name: string;
  kind: ConversationKind;
}

function makeDayItem(
  ctx: PullCtx,
  conv: ConvRef,
  day: string,
  msgs: SlackMessage[],
): DayItem {
  return {
    kind: 'day',
    channelId: conv.id,
    channelName: conv.name,
    convKind: conv.kind,
    day,
    teamUrl: ctx.teamUrl,
    messages: [...msgs]
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .map((m) => toRendered(m, ctx.users.resolve)),
  };
}

function makeThreadItem(
  ctx: PullCtx,
  channelId: string,
  channelName: string,
  threadTs: string,
  msgs: SlackMessage[],
): ThreadItem {
  return {
    kind: 'thread',
    channelId,
    channelName,
    threadTs,
    teamUrl: ctx.teamUrl,
    messages: msgs.map((m) => toRendered(m, ctx.users.resolve)),
  };
}

/**
 * Download the attachments of `msgs` into FileItems, emitted in the SAME
 * batch as their parent day/thread item so the engine resolves parentage
 * in-transaction.
 *
 *  - >50MB → item WITHOUT bytes (doc gets extraction_status 'too_large').
 *  - download failure → warn + NO item at all (deliberate deviation from
 *    v1's silent empty buffer: the next complete re-render retries it).
 */
async function collectFileItems(
  ctx: PullCtx,
  msgs: SlackMessage[],
  channelId: string,
  parentExternalId: string,
  parentType: string,
): Promise<FileItem[]> {
  const out: FileItem[] = [];
  for (const m of msgs) {
    for (const f of m.files ?? []) {
      if (!f.url_private || f.mode === 'tombstone') continue;
      if (ctx.seenFiles.has(f.id)) continue;
      const base: FileItem = {
        kind: 'file',
        id: f.id,
        filename: f.name || f.title || f.id,
        mime: f.mimetype ?? '',
        sizeBytes: f.size ?? 0,
        urlPrivate: f.url_private,
        channelId,
        ts: m.ts,
        parentExternalId,
        parentType,
      };
      if (base.sizeBytes > MAX_FILE_BYTES) {
        ctx.seenFiles.add(f.id);
        out.push(base);
        continue;
      }
      try {
        const bytes = await ctx.client.download(f.url_private);
        ctx.seenFiles.add(f.id);
        out.push({ ...base, bytes });
      } catch (e) {
        ctx.session.log(
          'warn',
          `slack: file ${f.id} download failed — skipped: ${errText(e)}`,
        );
      }
    }
  }
  return out;
}

interface WalkResult {
  latestTs: string;
  activeThreads: ActiveThread[];
  /** Last page's items + the final day flush — the CALLER folds these into
   *  its completion batch so items and cursor advance in one transaction. */
  tailItems: SlackItem[];
}

/**
 * Full history walk of one conversation: threads → thread items, loose
 * messages → day items. History pages arrive newest→oldest, so a day is
 * complete when an older day appears — the buffer flush keeps memory bounded
 * to one day regardless of channel size. Yields one batch per history page
 * that has a successor (cursor from `checkpoint`); returns the tail. Used by
 * backfill, by delta's mini-backfill of newly joined conversations, and —
 * with `oldest` bounding the window at a local day start — by delta's
 * page-aligned catch-up of long-dormant channels.
 * Returns null when aborted (the caller must return without completing).
 */
async function* walkConversation(
  ctx: PullCtx,
  conv: ConvRef,
  resume: BackfillProgress | undefined,
  phase: PullPhase,
  checkpoint: (p: BackfillProgress) => SlackCursor,
  oldest?: string,
): AsyncGenerator<Batch<SlackCursor, SlackItem>, WalkResult | null> {
  let latestTs = resume?.latest_ts ?? '0';
  const active: ActiveThread[] = resume ? snapshot(resume.active_threads) : [];
  let dayBuf: SlackMessage[] = resume ? snapshot(resume.day_buf) : [];
  let curDay: string | null = resume?.day ?? null;
  let items: SlackItem[] = [];

  const flushDay = async (): Promise<void> => {
    if (curDay && dayBuf.length) {
      const day = curDay;
      const msgs = dayBuf;
      items.push(makeDayItem(ctx, conv, day, msgs));
      items.push(
        ...(await collectFileItems(ctx, msgs, conv.id, `${conv.id}:${day}`, 'slack.day')),
      );
    }
    dayBuf = [];
  };

  for await (const page of ctx.client.pages<HistoryPage>(
    'conversations.history',
    { channel: conv.id, limit: 999, oldest },
    resume?.next_cursor,
  )) {
    if (ctx.session.signal.aborted) return null;
    for (const m of page.messages ?? []) {
      if (Number(m.ts) > Number(latestTs)) latestTs = m.ts;
      const isThreadRoot = m.thread_ts === m.ts && (m.reply_count ?? 0) > 0;
      if (isThreadRoot) {
        let thread: SlackMessage[];
        try {
          thread = await fetchThread(ctx.client, conv.id, m.ts);
        } catch (e) {
          // One bad thread out of thousands must not abort the whole walk —
          // skip it (never advancing the high-water mark past work not done).
          // Auth errors propagate: every later call would fail identically.
          if (isAuthError(e)) throw e;
          ctx.session.log(
            'warn',
            `slack: skipping thread ${conv.id}:${m.ts}: ${errText(e)}`,
          );
          continue;
        }
        const threadMsgs = thread.filter(indexable);
        if (threadMsgs.length) {
          items.push(makeThreadItem(ctx, conv.id, conv.name, m.ts, threadMsgs));
          items.push(
            ...(await collectFileItems(
              ctx,
              threadMsgs,
              conv.id,
              `${conv.id}:${m.ts}`,
              'slack.thread',
            )),
          );
        }
        const lastReply = m.latest_reply ?? m.ts;
        if (withinDays(ctx, lastReply, ACTIVE_THREAD_WINDOW_DAYS)) {
          active.push({
            channel: conv.id,
            thread_ts: m.ts,
            last_reply_ts: lastReply,
          });
        }
        continue;
      }
      // Reply broadcast back to the channel — already part of its thread doc.
      if (m.thread_ts && m.thread_ts !== m.ts) continue;
      if (!indexable(m)) continue;
      const day = dayKey(tsToDate(m.ts));
      if (day !== curDay) {
        await flushDay();
        curDay = day;
      }
      dayBuf.push(m);
    }
    const nextCursor = page.response_metadata?.next_cursor;
    if (nextCursor) {
      const cursor = checkpoint({
        conversation_id: conv.id,
        next_cursor: nextCursor,
        latest_ts: latestTs,
        active_threads: snapshot(active),
        day: curDay,
        day_buf: snapshot(dayBuf),
      });
      yield { phase, items, cursor };
      items = [];
    }
  }
  await flushDay();
  return { latestTs, activeThreads: active, tailItems: items };
}

async function* backfill(
  ctx: PullCtx,
  prior: SlackCursor | null,
): AsyncGenerator<Batch<SlackCursor, SlackItem>> {
  await ctx.users.ensurePreloaded(ctx.client);
  const convs = await listMemberConversations(ctx.client);
  const cursor: SlackCursor = prior?.conversations
    ? {
        ...snapshot(prior),
        active_threads: snapshot(prior.active_threads ?? []),
        backfill_done: [...(prior.backfill_done ?? [])],
      }
    : { conversations: {}, active_threads: [], backfill_done: [] };

  for (const c of convs) {
    if (ctx.session.signal.aborted) return;
    if (cursor.backfill_done!.includes(c.id)) continue;
    const conv: ConvRef = {
      id: c.id,
      name: conversationDisplayName(c, ctx.users.resolve),
      kind: kindOf(c),
    };
    const resume =
      cursor.backfill_progress?.conversation_id === c.id
        ? cursor.backfill_progress
        : undefined;
    const checkpoint = (p: BackfillProgress): SlackCursor => {
      cursor.backfill_progress = p;
      return snapshot(cursor);
    };

    let result: WalkResult | null = null;
    let failed = false;
    let failure: unknown;
    try {
      result = yield* walkConversation(ctx, conv, resume, 'backfill', checkpoint);
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (resume && e instanceof SlackApiError) {
        // A persisted page cursor can go stale across restarts; falling back
        // to a fresh walk of this conversation beats wedging the account
        // forever on the same dead cursor (v1 behavior).
        ctx.session.log(
          'warn',
          `slack backfill: saved cursor for ${c.id} rejected (${e.slackError}) — restarting the conversation from scratch`,
        );
        delete cursor.backfill_progress;
        try {
          result = yield* walkConversation(ctx, conv, undefined, 'backfill', checkpoint);
        } catch (e2) {
          if (isAuthError(e2)) throw e2;
          failed = true;
          failure = e2;
        }
      } else {
        failed = true;
        failure = e;
      }
    }
    if (failed) {
      // One broken conversation must not wedge the whole backfill — skip it
      // DURABLY (advance backfill_done past it) with a warning.
      ctx.session.log(
        'warn',
        `slack backfill: conversation ${conv.name} (${c.id}) failed — skipped: ${errText(failure)}`,
      );
      delete cursor.backfill_progress;
      cursor.backfill_done!.push(c.id);
      yield { phase: 'backfill', items: [], cursor: snapshot(cursor) };
      continue;
    }
    if (!result) return; // aborted mid-walk — resume from the last commit
    // Completion: the last page's items (incl. the final day flush) commit in
    // the SAME transaction that advances backfill_done past this conversation.
    delete cursor.backfill_progress;
    cursor.conversations[c.id] = {
      latest_ts: result.latestTs,
      name: conv.name,
      kind: conv.kind,
    };
    cursor.active_threads.push(...result.activeThreads);
    cursor.backfill_done!.push(c.id);
    yield { phase: 'backfill', items: result.tailItems, cursor: snapshot(cursor) };
  }

  // Backfill ends by flipping to a final live batch. Delta must never see a
  // backfill-shaped cursor again; polls: 0 makes the first delta poll refresh
  // membership (0 + 1 ≡ 1 mod LIST_REFRESH_EVERY).
  delete cursor.backfill_done;
  delete cursor.backfill_progress;
  cursor.polls = 0;
  yield { phase: 'live', items: [], cursor: snapshot(cursor) };
}

async function* delta(
  ctx: PullCtx,
  prior: SlackCursor,
  budget: number,
): AsyncGenerator<Batch<SlackCursor, SlackItem>> {
  const cursor = snapshot(prior);
  cursor.active_threads ??= [];
  const start = ctx.client.requestCount;
  const left = () => budget - (ctx.client.requestCount - start);

  await ctx.users.ensurePreloaded(ctx.client);
  cursor.polls = (cursor.polls ?? 0) + 1;

  // 1) Periodic membership refresh: prune left/deleted, mini-backfill new.
  if (cursor.polls % LIST_REFRESH_EVERY === 1) {
    const convs = await listMemberConversations(ctx.client);
    const liveIds = new Set(convs.map((c) => c.id));
    for (const id of Object.keys(cursor.conversations)) {
      if (!liveIds.has(id)) delete cursor.conversations[id];
    }
    cursor.active_threads = cursor.active_threads.filter((t) =>
      liveIds.has(t.channel),
    );
    for (const c of convs) {
      if (ctx.session.signal.aborted) return;
      if (cursor.conversations[c.id] || left() <= 2) continue;
      const conv: ConvRef = {
        id: c.id,
        name: conversationDisplayName(c, ctx.users.resolve),
        kind: kindOf(c),
      };
      let result: WalkResult | null;
      try {
        // Newly joined conversation: full walk. Page batches ride an
        // UNCHANGED cursor (upserts are idempotent); only the completion
        // batch installs the conversation — a crash mid-walk simply re-walks
        // it on a later refresh poll (v1's at-least-once shape).
        result = yield* walkConversation(ctx, conv, undefined, 'live', () =>
          snapshot(cursor),
        );
      } catch (e) {
        if (isAuthError(e)) throw e;
        ctx.session.log(
          'warn',
          `slack delta: mini-backfill of ${conv.name} (${c.id}) failed — will retry on a later refresh: ${errText(e)}`,
        );
        continue;
      }
      if (!result) return; // aborted
      cursor.conversations[c.id] = {
        latest_ts: result.latestTs,
        name: conv.name,
        kind: conv.kind,
      };
      cursor.active_threads.push(...result.activeThreads);
      yield { phase: 'live', items: result.tailItems, cursor: snapshot(cursor) };
    }
  }

  // 2) Poll conversations, stalest first — one batch per polled channel, so a
  //    channel's latest_ts only ever advances WITH that channel's items.
  const order = Object.entries(cursor.conversations).sort((x, y) =>
    (x[1].last_polled ?? '').localeCompare(y[1].last_polled ?? ''),
  );
  for (const [id, cc] of order) {
    if (ctx.session.signal.aborted) return;
    if (left() <= 0) break;
    const conv: ConvRef = { id, name: cc.name, kind: cc.kind };
    try {
      // COMPLETE-DAY INVARIANT (the key v1→v2 change): v2 upserts REPLACE
      // whole documents, so every emitted day must carry the complete day.
      // Clamp `oldest` DOWN from (latest_ts − 24h lookback) to the START of
      // the local day containing it: every local day inside the fetched
      // window is then fully covered, and re-rendering each one replaces its
      // doc idempotently instead of truncating it.
      const lookback = Math.max(
        0,
        Number(cc.latest_ts) - DELTA_LOOKBACK_SECONDS,
      );
      const oldest = localDayStartTs(String(lookback));

      // A catch-up window this deep means an unbounded backlog: do NOT drain
      // it into one in-memory array/batch. Route the channel through the
      // page-aligned walk instead (backfill's machinery), bounded below by
      // the same day-start `oldest`: per-page batches stay small, page
      // batches ride an UNCHANGED cursor (a crash re-detects the deep window
      // and re-walks idempotently), and the clamp keeps every day complete.
      if (ctx.now() / 1000 - Number(oldest) > MAX_DRAIN_WINDOW_SECONDS) {
        const result = yield* walkConversation(
          ctx,
          conv,
          undefined,
          'live',
          () => snapshot(cursor),
          oldest,
        );
        if (!result) return; // aborted
        if (Number(result.latestTs) > Number(cc.latest_ts))
          cc.latest_ts = result.latestTs;
        for (const t of result.activeThreads) {
          const known = cursor.active_threads.find(
            (x) => x.channel === t.channel && x.thread_ts === t.thread_ts,
          );
          if (!known) cursor.active_threads.push(t);
          else if (Number(t.last_reply_ts) > Number(known.last_reply_ts))
            known.last_reply_ts = t.last_reply_ts;
        }
        cc.last_polled = new Date(ctx.now()).toISOString();
        yield { phase: 'live', items: result.tailItems, cursor: snapshot(cursor) };
        continue;
      }

      const msgs: SlackMessage[] = [];
      for await (const page of ctx.client.pages<HistoryPage>(
        'conversations.history',
        { channel: id, oldest, limit: 999 },
      )) {
        msgs.push(...(page.messages ?? []));
      }
      msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
      const byDay = new Map<string, SlackMessage[]>();
      for (const m of msgs) {
        if (Number(m.ts) > Number(cc.latest_ts)) cc.latest_ts = m.ts;
        const isRoot = m.thread_ts === m.ts && (m.reply_count ?? 0) > 0;
        if (isRoot) {
          if (
            !cursor.active_threads.some(
              (t) => t.channel === id && t.thread_ts === m.ts,
            )
          ) {
            // '0' = fetch the whole thread in the replies pass below.
            cursor.active_threads.push({
              channel: id,
              thread_ts: m.ts,
              last_reply_ts: '0',
            });
          }
          continue;
        }
        if (m.thread_ts && m.thread_ts !== m.ts) continue;
        if (!indexable(m)) continue;
        const day = dayKey(tsToDate(m.ts));
        byDay.set(day, [...(byDay.get(day) ?? []), m]);
      }
      const items: SlackItem[] = [];
      for (const [day, dayMsgs] of byDay) {
        items.push(makeDayItem(ctx, conv, day, dayMsgs));
        items.push(
          ...(await collectFileItems(ctx, dayMsgs, id, `${id}:${day}`, 'slack.day')),
        );
      }
      cc.last_polled = new Date(ctx.now()).toISOString();
      yield { phase: 'live', items, cursor: snapshot(cursor) };
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (e instanceof SlackApiError && DROP_CODES.has(e.slackError)) {
        // Kicked / deleted / archived: drop the conversation (and its
        // threads) from the cursor durably, keep polling the rest.
        delete cursor.conversations[id];
        cursor.active_threads = cursor.active_threads.filter(
          (t) => t.channel !== id,
        );
        yield { phase: 'live', items: [], cursor: snapshot(cursor) };
        continue;
      }
      throw e;
    }
  }

  // 3) Active threads: probe for new replies, re-emit the whole thread doc.
  const keep: ActiveThread[] = [];
  for (const t of [...cursor.active_threads]) {
    if (ctx.session.signal.aborted) return;
    if (left() <= 1) {
      keep.push(t); // budget spent — keep untouched for the next poll
      continue;
    }
    const cc = cursor.conversations[t.channel];
    if (!cc) continue; // channel pruned — thread goes with it
    try {
      const probe = await ctx.client.call<HistoryPage>(
        'conversations.replies',
        {
          channel: t.channel,
          ts: t.thread_ts,
          oldest: t.last_reply_ts,
          limit: 999,
        },
      );
      const fresh = (probe.messages ?? []).filter(
        (m) => Number(m.ts) > Number(t.last_reply_ts),
      );
      if (fresh.length) {
        const thread = await fetchThread(ctx.client, t.channel, t.thread_ts);
        const threadMsgs = thread.filter(indexable);
        const items: SlackItem[] = [];
        if (threadMsgs.length) {
          items.push(
            makeThreadItem(ctx, t.channel, cc.name, t.thread_ts, threadMsgs),
          );
          items.push(
            ...(await collectFileItems(
              ctx,
              threadMsgs,
              t.channel,
              `${t.channel}:${t.thread_ts}`,
              'slack.thread',
            )),
          );
        }
        if (thread.length) t.last_reply_ts = thread[thread.length - 1].ts;
        // t is the same object inside cursor.active_threads, so this batch's
        // cursor carries the advanced last_reply_ts WITH the thread's items.
        yield { phase: 'live', items, cursor: snapshot(cursor) };
      }
      if (
        withinDays(
          ctx,
          t.last_reply_ts === '0' ? t.thread_ts : t.last_reply_ts,
          ACTIVE_THREAD_WINDOW_DAYS,
        )
      ) {
        keep.push(t);
      }
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (e instanceof SlackApiError && DROP_CODES.has(e.slackError)) continue;
      throw e;
    }
  }
  cursor.active_threads = keep;

  // Final batch persists the poll counter, thread expiry, and any pruning
  // even on a tick where nothing else changed.
  yield { phase: 'live', items: [], cursor: snapshot(cursor) };
}

export interface SlackSourceOptions {
  /** Test seams — instant clock so suites never wait out the throttle. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam — delta request budget override (default 40). */
  requestBudget?: number;
}

export function createSlackSource(
  host: HostFor<'net'>,
  opts: SlackSourceOptions = {},
): Source<SlackCursor, SlackItem> {
  const now = opts.now ?? Date.now;
  /** One user directory per account, cached across pull cycles — users.list
   *  is Tier 2 and must not run per delta poll. */
  const directories = new Map<string, SlackUserDirectory>();

  const makeClient = (token: string) =>
    new SlackClient({
      fetch: host.net.fetch as NetFetch,
      token,
      sleep: opts.sleep,
      now: opts.now,
    });

  async function requireToken(session: Session): Promise<string> {
    const creds = await session.credentials();
    const token = creds?.password;
    if (!token)
      throw new SourceAuthError('no Slack credentials — reconnect the account');
    return token;
  }

  function makeCtx(session: Session, client: SlackClient): PullCtx {
    const key = String(session.account.id ?? session.account.identifier ?? '');
    let users = directories.get(key);
    if (!users) {
      users = new SlackUserDirectory();
      directories.set(key, users);
    }
    const cfgUrl = session.account.config?.team_url;
    return {
      client,
      session,
      users,
      teamUrl: typeof cfgUrl === 'string' && cfgUrl ? cfgUrl : 'https://app.slack.com/',
      now,
      seenFiles: new Set(),
    };
  }

  return {
    descriptor: {
      id: 'slack',
      name: 'Slack',
      documentTypes: ['slack.day', 'slack.thread', 'file'],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '15m' },
    },

    async connect(auth: AuthChannel) {
      const answers = await auth.prompt({
        type: 'object',
        required: ['password'],
        description:
          'Slack indexing uses a token from an internal Slack app you create yourself — this keeps standard rate limits. The scopes are read-only apart from chat:write, which is used only to post replies you confirm in KIAgent.',
        'x-steps': [
          {
            title: 'Create the Slack app',
            body: 'api.slack.com/apps → Create New App → From a manifest → pick your workspace → paste this:',
            link: 'https://api.slack.com/apps?new_app=1',
            copy: SLACK_APP_MANIFEST,
          },
          {
            title: 'Install to your workspace',
            body: 'On the app page: Install App → Install to Workspace, then copy the User OAuth Token from OAuth & Permissions.',
          },
        ],
        properties: {
          password: {
            type: 'string',
            title: 'User OAuth Token',
            format: 'password',
            examples: ['xoxp-…'],
            description: 'Starts with xoxp- (a user token, not the xoxb- bot token).',
          },
        },
      });
      const token =
        typeof answers.password === 'string' ? answers.password.trim() : '';
      // Reject wrong-shaped tokens BEFORE any network call.
      if (token.startsWith('xoxb-'))
        throw new Error(
          'That is a Bot token (xoxb-…). Paste the User OAuth Token (xoxp-…) from the same OAuth & Permissions page.',
        );
      if (!token.startsWith('xoxp-'))
        throw new Error('Expected a User OAuth Token starting with xoxp-.');
      const res = (await host.net.fetch(`${SLACK_API_BASE}/auth.test`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })) as HostResponse;
      if (res.status < 200 || res.status >= 300)
        throw new Error(`Slack returned HTTP ${res.status}`);
      const granted = (res.headers['x-oauth-scopes'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const j = JSON.parse(new TextDecoder().decode(res.body)) as {
        ok: boolean;
        error?: string;
        url?: string;
        team?: string;
        team_id?: string;
      };
      if (!j.ok)
        throw new Error(`Slack rejected the token: ${j.error ?? 'unknown error'}`);
      const missing = SLACK_USER_SCOPES.filter((s) => !granted.includes(s));
      if (missing.length)
        throw new Error(
          `Token is missing scopes: ${missing.join(', ')}. Re-create the app from the README's app manifest and reinstall it to the workspace.`,
        );
      return {
        identifier: j.team ?? j.team_id ?? 'slack',
        config: {
          team_id: j.team_id ?? '',
          team_url: j.url ?? 'https://app.slack.com/',
        },
      };
    },

    async *pull(session: Session, cursor: SlackCursor | null) {
      try {
        const token = await requireToken(session);
        const client = makeClient(token);
        const ctx = makeCtx(session, client);
        if (
          cursor === null ||
          !cursor.conversations ||
          cursor.backfill_done ||
          cursor.backfill_progress
        ) {
          yield* backfill(ctx, cursor);
        } else {
          yield* delta(ctx, cursor, opts.requestBudget ?? DELTA_REQUEST_BUDGET);
        }
      } catch (e) {
        // The platform surfaces lastError verbatim — make dead-token failures
        // actionable for the user. SourceAuthError's `code: 'auth'` (see
        // ./kiagent-source-errors) is what drives the engine to
        // `needsReauth` and stops retries — a plain Error here (or one
        // converted anywhere upstream of this single boundary) would just
        // burn the transient-retry budget forever on a dead token.
        if (isAuthError(e))
          throw new SourceAuthError(`${errText(e)} — reconnect the account`);
        throw e;
      }
    },

    // NO reconcile() — deliberate v1 parity. Slack offers no cheap full
    // listing of everything indexed (days/threads would need replaying the
    // entire history walk), so upstream deletions are handled at CHANNEL
    // granularity by delta's cursor pruning instead. A partial listing here
    // would be worse than none: the engine archives whatever a "complete"
    // listing misses.

    toDocument(item: SlackItem) {
      switch (item.kind) {
        case 'day':
          return dayToDocument(item);
        case 'thread':
          return threadToDocument(item);
        case 'file':
          return fileToDocument(item);
        default:
          return null;
      }
    },

    async fetchBytes(session: Session, doc: Document) {
      const url = doc.metadata['url_private'];
      if (typeof url !== 'string' || !url) return null;
      const size = doc.metadata['size_bytes'];
      if (typeof size === 'number' && size > MAX_FILE_BYTES) return null;
      try {
        const token = await requireToken(session);
        const bytes = await makeClient(token).download(url);
        return bytes.byteLength > MAX_FILE_BYTES ? null : bytes;
      } catch {
        return null;
      }
    },
  };
}
