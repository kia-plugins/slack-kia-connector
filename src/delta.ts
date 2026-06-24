import { SlackApiError } from './client';
import {
  ACTIVE_THREAD_WINDOW_DAYS,
  backfillConversation,
  conversationDisplayName,
  docArgsFor,
  fetchThread,
  kindOf,
  listMemberConversations,
  withinDays,
  type SlackSyncArgs,
} from './backfill';
import {
  appendToChannelDay,
  dayKey,
  indexable,
  tsToDate,
  upsertSlackThread,
} from './thread-builder';
import type { SlackCursor, SlackMessage } from './types';

export const DELTA_REQUEST_BUDGET = 40;
export const LIST_REFRESH_EVERY = 10;
/** Re-read this far behind latest_ts so replies turning a recent message into
 *  a thread root are noticed (replies never appear in channel history).
 *  Known constraint: if polling pauses for longer than this window AND a
 *  budget break abandons older history pages mid-catch-up, messages between
 *  the old cursor and (newest - lookback) are skipped for good. Accepted —
 *  fixing it needs per-conversation pagination cursors; under the normal
 *  30s–30min cadence the window always covers the gap. */
export const DELTA_LOOKBACK_SECONDS = 86_400;

const DROP_CODES = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
]);

interface HistoryPage {
  ok: boolean;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackDeltaArgs extends SlackSyncArgs {
  /** Override for tests; default DELTA_REQUEST_BUDGET. */
  requestBudget?: number;
}

export async function runSlackDelta(a: SlackDeltaArgs): Promise<void> {
  const state = await a.ctx.loadSyncState();
  const cursor = state?.cursor_json as unknown as SlackCursor | undefined;
  if (!cursor?.conversations)
    throw new Error('slack delta: no cursor — backfill first');

  const budget = a.requestBudget ?? DELTA_REQUEST_BUDGET;
  const start = a.client.requestCount;
  const left = () => budget - (a.client.requestCount - start);

  await a.users.ensurePreloaded();
  cursor.polls = (cursor.polls ?? 0) + 1;

  // 1) Periodic membership refresh: prune left/deleted, mini-backfill new.
  if (cursor.polls % LIST_REFRESH_EVERY === 1) {
    const convs = await listMemberConversations(a.client);
    const liveIds = new Set(convs.map((c) => c.id));
    for (const id of Object.keys(cursor.conversations)) {
      if (!liveIds.has(id)) delete cursor.conversations[id];
    }
    cursor.active_threads = cursor.active_threads.filter((t) =>
      liveIds.has(t.channel),
    );
    for (const c of convs) {
      if (cursor.conversations[c.id] || left() <= 2) continue;
      const name = conversationDisplayName(c, a.users.resolve);
      const kind = kindOf(c);
      const r = await backfillConversation(
        a,
        docArgsFor(a, c.id, name, kind),
        c.id,
        'append',
      );
      cursor.conversations[c.id] = { latest_ts: r.latestTs, name, kind };
      cursor.active_threads.push(...r.activeThreads);
    }
  }

  // 2) Poll conversations, stalest first.
  const order = Object.entries(cursor.conversations).sort((x, y) =>
    (x[1].last_polled ?? '').localeCompare(y[1].last_polled ?? ''),
  );
  for (const [id, cc] of order) {
    if (left() <= 0) break;
    const docArgs = docArgsFor(a, id, cc.name, cc.kind);
    try {
      const oldest = String(
        Math.max(0, Number(cc.latest_ts) - DELTA_LOOKBACK_SECONDS),
      );
      const msgs: SlackMessage[] = [];
      for await (const page of a.client.pages<HistoryPage>(
        'conversations.history',
        { channel: id, oldest, limit: 999 },
      )) {
        msgs.push(...(page.messages ?? []));
        if (left() <= 0) break;
      }
      msgs.sort((x, y) => Number(x.ts) - Number(y.ts));
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
      for (const [day, dayMsgs] of byDay) {
        await appendToChannelDay(docArgs, day, dayMsgs);
      }
      cc.last_polled = new Date().toISOString();
    } catch (e) {
      if (e instanceof SlackApiError && DROP_CODES.has(e.slackError)) {
        delete cursor.conversations[id];
        cursor.active_threads = cursor.active_threads.filter(
          (t) => t.channel !== id,
        );
        continue;
      }
      throw e; // auth errors carry code=401 → scheduler flags needs_reauth
    }
  }

  // 3) Active threads: fetch new replies, rebuild the thread doc.
  const keep: SlackCursor['active_threads'] = [];
  for (const t of cursor.active_threads) {
    if (left() <= 1) {
      keep.push(t);
      continue;
    }
    const cc = cursor.conversations[t.channel];
    if (!cc) continue;
    try {
      const probe = await a.client.call<HistoryPage>('conversations.replies', {
        channel: t.channel,
        ts: t.thread_ts,
        oldest: t.last_reply_ts,
        limit: 999,
      });
      const fresh = (probe.messages ?? []).filter(
        (m) => Number(m.ts) > Number(t.last_reply_ts),
      );
      if (fresh.length) {
        const thread = await fetchThread(a.client, t.channel, t.thread_ts);
        await upsertSlackThread(
          docArgsFor(a, t.channel, cc.name, cc.kind),
          thread,
        );
        t.last_reply_ts = thread.at(-1)!.ts;
      }
      if (
        withinDays(
          t.last_reply_ts === '0' ? t.thread_ts : t.last_reply_ts,
          ACTIVE_THREAD_WINDOW_DAYS,
        )
      ) {
        keep.push(t);
      }
    } catch (e) {
      if (e instanceof SlackApiError && DROP_CODES.has(e.slackError)) continue;
      throw e;
    }
  }
  cursor.active_threads = keep;

  await a.ctx.saveSyncState({
    status: 'live',
    cursor_json: cursor as unknown as Record<string, unknown>,
    last_sync_at: new Date(),
  });
}
