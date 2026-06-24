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
 *  re-walks it from the newest message. Persisted after each history page. */
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

/** Shape persisted in sync_state.cursor_json for source='slack'. */
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

export interface SlackToken {
  access_token: string;
  team_id: string;
  user_id: string;
  team_name: string;
  /** e.g. 'https://acme.slack.com/' (from auth.test `url`). */
  team_url: string;
  scope: string;
}
