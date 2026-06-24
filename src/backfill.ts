import type { Converter, Host } from './host';
import { mediaDir } from './media-dir';
import type { SlackClient } from './client';
import type { SlackUserDirectory } from './users';
import {
  appendToChannelDay,
  dayKey,
  indexable,
  tsToDate,
  upsertChannelDay,
  upsertSlackThread,
  type SlackConversationDocArgs,
} from './thread-builder';
import { SlackApiError } from './client';
import type {
  ActiveThread,
  BackfillProgress,
  ConversationKind,
  SlackConversation,
  SlackCursor,
  SlackMessage,
  SlackToken,
} from './types';

export const ACTIVE_THREAD_WINDOW_DAYS = 14;

export interface SlackSyncArgs {
  ctx: Host;
  converter: Converter | undefined;
  client: SlackClient;
  users: SlackUserDirectory;
  accountId: bigint;
  token: SlackToken;
}

export interface SlackBackfillArgs extends SlackSyncArgs {
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
}

interface HistoryPage {
  ok: boolean;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

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

export async function listMemberConversations(
  client: SlackClient,
): Promise<SlackConversation[]> {
  const out: SlackConversation[] = [];
  for await (const page of client.pages<{
    ok: boolean;
    channels?: SlackConversation[];
  }>('conversations.list', {
    types: 'public_channel,private_channel,im,mpim',
    exclude_archived: true,
    limit: 200,
  })) {
    for (const c of page.channels ?? []) {
      if (c.is_im || c.is_mpim || c.is_member) out.push(c);
    }
  }
  return out;
}

export function withinDays(ts: string, days: number): boolean {
  return Date.now() - tsToDate(ts).getTime() < days * 86_400_000;
}

export function docArgsFor(
  a: SlackSyncArgs,
  channelId: string,
  channelName: string,
  kind: ConversationKind,
): SlackConversationDocArgs {
  return {
    ctx: a.ctx,
    converter: a.converter,
    mediaDir: mediaDir(a.ctx.dataDir),
    accountId: a.accountId,
    teamUrl: a.token.team_url,
    channelId,
    channelName,
    kind,
    resolveUser: a.users.resolve,
    downloadFile: (u) => a.client.download(u),
  };
}

export async function fetchThread(
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

export interface ConversationSyncResult {
  latestTs: string;
  activeThreads: ActiveThread[];
}

export interface BackfillConversationOpts {
  /** Resume the walk mid-conversation from a persisted checkpoint. */
  resume?: BackfillProgress;
  /** Called after each fully-processed history page that has a successor —
   *  the persisted state lets a restart continue page-aligned. */
  onCheckpoint?: (p: BackfillProgress) => Promise<void>;
}

/**
 * Full history walk of one conversation: threads → thread docs, loose
 * messages → day docs. History pages arrive newest→oldest, so a day is
 * complete when an older day appears — the buffer flush keeps memory bounded
 * to one day regardless of channel size. Used by backfill AND by delta's
 * mini-backfill of newly joined conversations (delta merges via append).
 *
 * A thread whose replies can't be fetched (transient HTTP error that survived
 * the client's retries) is logged and skipped — one bad thread out of
 * thousands must not abort the whole walk. Auth errors still propagate: every
 * subsequent call would fail the same way and the account needs reauth.
 */
export async function backfillConversation(
  a: SlackSyncArgs & { signal?: AbortSignal },
  docArgs: SlackConversationDocArgs,
  conversationId: string,
  mode: 'overwrite' | 'append' = 'overwrite',
  opts: BackfillConversationOpts = {},
): Promise<ConversationSyncResult> {
  let latestTs = opts.resume?.latest_ts ?? '0';
  const active: ActiveThread[] = [...(opts.resume?.active_threads ?? [])];
  let dayBuf: SlackMessage[] = [...(opts.resume?.day_buf ?? [])];
  let curDay: string | null = opts.resume?.day ?? null;
  const writeDay = mode === 'overwrite' ? upsertChannelDay : appendToChannelDay;
  const flush = async () => {
    if (curDay && dayBuf.length) await writeDay(docArgs, curDay, dayBuf);
    dayBuf = [];
  };

  for await (const page of a.client.pages<HistoryPage>(
    'conversations.history',
    { channel: conversationId, limit: 999 },
    opts.resume?.next_cursor,
  )) {
    if (a.signal?.aborted) throw new Error('slack backfill stopped');
    for (const m of page.messages ?? []) {
      if (Number(m.ts) > Number(latestTs)) latestTs = m.ts;
      const isThreadRoot = m.thread_ts === m.ts && (m.reply_count ?? 0) > 0;
      if (isThreadRoot) {
        let thread: SlackMessage[];
        try {
          thread = await fetchThread(a.client, conversationId, m.ts);
        } catch (e) {
          if (e instanceof SlackApiError && e.code === 401) throw e;
          if (a.signal?.aborted) throw e;
          console.warn(
            `[slack] skipping thread ${conversationId}:${m.ts}: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        await upsertSlackThread(docArgs, thread);
        const lastReply = m.latest_reply ?? m.ts;
        if (withinDays(lastReply, ACTIVE_THREAD_WINDOW_DAYS)) {
          active.push({
            channel: conversationId,
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
        await flush();
        curDay = day;
      }
      dayBuf.push(m);
    }
    const nextCursor = page.response_metadata?.next_cursor;
    if (nextCursor && opts.onCheckpoint) {
      await opts.onCheckpoint({
        conversation_id: conversationId,
        next_cursor: nextCursor,
        latest_ts: latestTs,
        active_threads: active,
        day: curDay,
        day_buf: dayBuf,
      });
    }
  }
  await flush();
  return { latestTs, activeThreads: active };
}

export async function runSlackBackfill(a: SlackBackfillArgs): Promise<void> {
  await a.users.ensurePreloaded();
  const convs = await listMemberConversations(a.client);
  const state = await a.ctx.loadSyncState();
  const prior = state?.cursor_json as unknown as SlackCursor | undefined;
  const cursor: SlackCursor = prior?.conversations
    ? {
        ...prior,
        active_threads: prior.active_threads ?? [],
        backfill_done: prior.backfill_done ?? [],
      }
    : { conversations: {}, active_threads: [], backfill_done: [] };
  cursor.backfill_done ??= [];

  const total = convs.length;
  await a.ctx.saveSyncState({
    status: 'backfilling',
    backfill_total_estimate: total,
    backfill_done_count: cursor.backfill_done.length,
  });

  for (const c of convs) {
    if (a.signal.aborted) throw new Error('slack backfill stopped');
    if (cursor.backfill_done.includes(c.id)) continue;
    const name = conversationDisplayName(c, a.users.resolve);
    const kind = kindOf(c);
    const docArgs = docArgsFor(a, c.id, name, kind);
    const onCheckpoint = async (p: BackfillProgress) => {
      cursor.backfill_progress = p;
      await a.ctx.saveSyncState({
        status: 'backfilling',
        cursor_json: cursor as unknown as Record<string, unknown>,
        backfill_done_count: cursor.backfill_done!.length,
        backfill_total_estimate: total,
      });
    };
    let resume =
      cursor.backfill_progress?.conversation_id === c.id
        ? cursor.backfill_progress
        : undefined;
    if (resume)
      console.info(
        `[slack] backfill resuming ${name} (${c.id}) from saved page cursor`,
      );
    else console.info(`[slack] backfill walking ${name} (${c.id})`);
    let r: ConversationSyncResult;
    try {
      r = await backfillConversation(a, docArgs, c.id, 'overwrite', {
        resume,
        onCheckpoint,
      });
    } catch (e) {
      // A persisted page cursor can go stale across restarts; falling back to
      // a fresh walk of this conversation beats wedging the account forever
      // on the same dead cursor.
      if (resume && e instanceof SlackApiError) {
        console.warn(
          `[slack] saved cursor for ${c.id} rejected (${e.slackError}) — restarting the conversation from scratch`,
        );
        resume = undefined;
        delete cursor.backfill_progress;
        r = await backfillConversation(a, docArgs, c.id, 'overwrite', {
          onCheckpoint,
        });
      } else throw e;
    }
    delete cursor.backfill_progress;
    cursor.conversations[c.id] = { latest_ts: r.latestTs, name, kind };
    cursor.active_threads.push(...r.activeThreads);
    cursor.backfill_done.push(c.id);
    await a.ctx.saveSyncState({
      status: 'backfilling',
      cursor_json: cursor as unknown as Record<string, unknown>,
      backfill_done_count: cursor.backfill_done.length,
      backfill_total_estimate: total,
    });
    a.onProgress(cursor.backfill_done.length, total);
  }

  delete cursor.backfill_done;
  delete cursor.backfill_progress;
  await a.ctx.saveSyncState({
    status: 'live',
    cursor_json: cursor as unknown as Record<string, unknown>,
    last_sync_at: new Date(),
  });
}
