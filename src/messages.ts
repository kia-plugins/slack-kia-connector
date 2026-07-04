/**
 * Pure message/format helpers and the item → DocumentInput builders — the v2
 * home of v1's `src/thread-builder.ts` rendering (see `git show
 * main:src/thread-builder.ts`). Everything here is PURE: user names and
 * mrkdwn are resolved at pull time into RenderedMessage, so toDocument needs
 * no directory and no I/O. What did NOT survive from v1: upsertDocument /
 * findBySourceId plumbing (the engine owns writes now), the converter (the
 * engine converts `binary` docs itself), the media cache + byte source
 * (fetchBytes re-downloads from Slack instead), and appendToChannelDay —
 * v2 upserts replace whole documents, so every day item carries the complete
 * day (see the delta day-start clamp in source.ts).
 */
import type { DocumentInput } from './kiagent-contracts';
import { renderMrkdwn } from './render';
import type {
  DayItem,
  FileItem,
  RenderedMessage,
  SlackMessage,
  ThreadItem,
} from './types';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const IGNORED_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'message_deleted',
]);

export function tsToDate(ts: string): Date {
  return new Date(Math.round(parseFloat(ts) * 1000));
}

/** Local-time YYYY-MM-DD (day docs group by the user's wall-clock day). */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start of the LOCAL day containing the given Slack ts, as a Slack ts. */
export function localDayStartTs(ts: string): string {
  const d = tsToDate(ts);
  d.setHours(0, 0, 0, 0);
  return String(Math.max(0, d.getTime() / 1000));
}

export function archiveUrl(
  teamUrl: string,
  channelId: string,
  ts: string,
): string {
  return `${teamUrl.replace(/\/$/, '')}/archives/${channelId}/p${ts.replace('.', '')}`;
}

export function indexable(msg: SlackMessage): boolean {
  if (msg.subtype && IGNORED_SUBTYPES.has(msg.subtype)) return false;
  return Boolean(msg.text?.trim() || msg.files?.length);
}

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/** Resolve a raw Slack message into the pre-rendered item shape. */
export function toRendered(
  m: SlackMessage,
  resolveUser: (id?: string) => string,
): RenderedMessage {
  return {
    ts: m.ts,
    userName: resolveUser(m.user ?? m.bot_id),
    text: renderMrkdwn(m.text ?? '', resolveUser),
    fileIds: (m.files ?? [])
      .filter((f) => f.url_private && f.mode !== 'tombstone')
      .map((f) => f.id),
  };
}

/** `**name** · YYYY-MM-DD HH:mm` + the rendered body — one section per message. */
const section = (m: RenderedMessage) =>
  `**${m.userName}** · ${fmt(tsToDate(m.ts))}\n\n${m.text}`;

function baseMetadata(
  channelId: string,
  channelName: string,
  messages: RenderedMessage[],
): Record<string, unknown> {
  return {
    slack_channel_id: channelId,
    slack_channel_name: channelName,
    message_count: messages.length,
    participants: [...new Set(messages.map((m) => m.userName))],
    first_message_at: tsToDate(messages[0].ts).toISOString(),
    last_message_at: tsToDate(messages[messages.length - 1].ts).toISOString(),
  };
}

export function dayToDocument(item: DayItem): DocumentInput | null {
  const msgs = item.messages;
  if (!msgs.length) return null;
  const markdown = [
    `# ${item.channelName} — ${item.day}`,
    '---',
    ...msgs.map(section),
  ].join('\n\n');
  return {
    externalId: `${item.channelId}:${item.day}`,
    type: 'slack.day',
    title: `${item.channelName} — ${item.day}`,
    markdown,
    url: archiveUrl(item.teamUrl, item.channelId, msgs[0].ts),
    metadata: {
      ...baseMetadata(item.channelId, item.channelName, msgs),
      conversation_type: item.convKind,
    },
    createdAt: tsToDate(msgs[0].ts).toISOString(),
  };
}

export function threadToDocument(item: ThreadItem): DocumentInput | null {
  const msgs = item.messages;
  if (!msgs.length) return null;
  const rootText = msgs[0].text.trim();
  const markdown = [
    `# ${item.channelName} — thread`,
    `> ${msgs.length} messages · ${fmt(tsToDate(msgs[0].ts))} → ${fmt(tsToDate(msgs[msgs.length - 1].ts))}`,
    '---',
    ...msgs.map(section),
  ].join('\n\n');
  return {
    externalId: `${item.channelId}:${item.threadTs}`,
    type: 'slack.thread',
    title: `${item.channelName}: ${(rootText || '(no text)').slice(0, 80)}`,
    markdown,
    url: archiveUrl(item.teamUrl, item.channelId, item.threadTs),
    metadata: {
      ...baseMetadata(item.channelId, item.channelName, msgs),
      slack_thread_ts: item.threadTs,
    },
    createdAt: tsToDate(msgs[0].ts).toISOString(),
  };
}

export function fileToDocument(item: FileItem): DocumentInput {
  return {
    externalId: item.id,
    type: 'file',
    title: item.filename,
    // Binary in, markdown out is the ENGINE's job (built-in parsers, then the
    // OCR/VLM deep-extraction pass) — v1's converter/media-cache is gone.
    markdown: null,
    binary: item.bytes
      ? { bytes: item.bytes, mime: item.mime, filename: item.filename }
      : undefined,
    metadata: {
      filename: item.filename,
      mime_type: item.mime,
      size_bytes: item.sizeBytes,
      url_private: item.urlPrivate,
      slack_channel_id: item.channelId,
      // bytes are only ever absent for the >50MB skip — mark it so the
      // extraction pipeline knows there is nothing to parse.
      ...(item.bytes ? {} : { extraction_status: 'too_large' }),
    },
    parent: { externalId: item.parentExternalId, type: item.parentType },
    createdAt: tsToDate(item.ts).toISOString(),
  };
}
