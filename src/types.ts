// ── Slack wire shapes (unchanged from v1) ───────────────────────────────────

export type ConversationKind =
  | 'public_channel'
  | 'private_channel'
  | 'im'
  | 'mpim';

export interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  /** im only: the counterpart user id. */
  user?: string;
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  mode?: string; // 'tombstone' = deleted
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackFile[];
}

// ── Cursor (v1 SlackCursor ported verbatim — it is already crash-safe) ──────

export interface CursorConversation {
  latest_ts: string;
  name: string;
  kind: ConversationKind;
  /** ISO timestamp of the last delta poll — drives stalest-first rotation. */
  last_polled?: string;
}

export interface ActiveThread {
  channel: string;
  thread_ts: string;
  /** '0' = newly discovered root; the replies poll fetches the whole thread. */
  last_reply_ts: string;
}

/** Page-aligned resume point inside one conversation's backfill walk. A giant
 *  channel takes hours to walk; without this, every error or app restart
 *  re-walks it from the newest message. Committed with each history page. */
export interface BackfillProgress {
  conversation_id: string;
  /** conversations.history cursor for the next unprocessed page. */
  next_cursor: string;
  /** Newest ts seen so far (first page of the original walk). */
  latest_ts: string;
  /** Active threads accumulated over the already-walked pages. */
  active_threads: ActiveThread[];
  /** Day-doc buffer at the checkpoint: the walk is newest→oldest and a day
   *  only flushes when an older day appears, so the in-flight day's messages
   *  must survive a restart or they'd be silently missing from its doc. */
  day: string | null;
  day_buf: SlackMessage[];
}

/** Persisted as the account cursor (committed transactionally with items). */
export interface SlackCursor {
  conversations: Record<string, CursorConversation>;
  active_threads: ActiveThread[];
  /** Present only while a backfill is in flight — conversation ids already done. */
  backfill_done?: string[];
  /** Present only while a backfill is mid-conversation. */
  backfill_progress?: BackfillProgress;
  /** Delta poll counter (drives the every-Nth conversations.list refresh). */
  polls?: number;
}

// ── Items (pull output; toDocument input — everything pre-resolved) ─────────

/** One message, fully resolved at pull time (user names looked up, mrkdwn
 *  already rendered to markdown) so toDocument stays PURE. */
export interface RenderedMessage {
  ts: string;
  userName: string;
  /** renderMrkdwn output — markdown, not raw mrkdwn. */
  text: string;
  fileIds: string[];
}

export interface DayItem {
  kind: 'day';
  channelId: string;
  channelName: string;
  convKind: ConversationKind;
  /** Local YYYY-MM-DD. Carries the COMPLETE day's messages, always —
   *  v2 upserts replace whole documents (no read-modify-write). */
  day: string;
  teamUrl: string;
  /** Ascending by ts. */
  messages: RenderedMessage[];
}

export interface ThreadItem {
  kind: 'thread';
  channelId: string;
  channelName: string;
  threadTs: string;
  teamUrl: string;
  /** Root + replies, ascending by ts — always the FULL thread. */
  messages: RenderedMessage[];
}

export interface FileItem {
  kind: 'file';
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Absent when the file exceeds MAX_FILE_BYTES (extraction_status
   *  'too_large'). Download failures never become items at all. */
  bytes?: Uint8Array;
  urlPrivate: string;
  channelId: string;
  /** ts of the message that carried the file — the doc's archive permalink. */
  ts: string;
  teamUrl: string;
  /** The day/thread doc this file belongs to — emitted in the SAME batch so
   *  the engine resolves parentage in-transaction. */
  parentExternalId: string;
  parentType: string;
}

export type SlackItem = DayItem | ThreadItem | FileItem;
