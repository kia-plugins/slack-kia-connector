import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DocumentId } from '@alpha-cent/connector-sdk';
import type { Converter, Host } from './host';
import { renderMrkdwn } from './render';
import type { ConversationKind, SlackMessage } from './types';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const IGNORED_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'message_deleted',
]);

export interface SlackConversationDocArgs {
  ctx: Host;
  /** The host's document converter. May be undefined in some host contexts —
   *  callers must guard; an unconverted file leaves markdown null so the host
   *  auto-enrolls it into the deep-extraction (OCR/VLM) pass. */
  converter: Converter | undefined;
  /** Local content-addressed cache dir for downloaded file bytes
   *  (`<dataDir>/slack/media`). The OCR pass re-reads bytes from here via the
   *  byte source, so out-of-process connectors don't re-download from Slack. */
  mediaDir: string;
  accountId: bigint;
  /** e.g. 'https://acme.slack.com/'. */
  teamUrl: string;
  channelId: string;
  /** Display name: '#general', 'DM with alice', 'Group DM: alice, bob'. */
  channelName: string;
  kind: ConversationKind;
  resolveUser: (id?: string) => string;
  downloadFile: (url: string) => Promise<Buffer>;
}

export function tsToDate(ts: string): Date {
  return new Date(Math.round(parseFloat(ts) * 1000));
}

/** Local-time YYYY-MM-DD (day docs group by the user's wall-clock day). */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

const sha256 = (s: string | Buffer) =>
  crypto.createHash('sha256').update(s).digest('hex');

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/**
 * Persist file bytes to the content-addressed cache atomically (temp + rename):
 * a crash mid-write must never leave a partial file whose NAME is the full
 * content hash, because reads don't re-validate and corrupt bytes could later
 * reach OCR. Rename within the same dir is atomic on local filesystems.
 */
async function cacheBytes(
  baseDir: string,
  hash: string,
  bytes: Buffer,
): Promise<void> {
  await fsp.mkdir(baseDir, { recursive: true });
  const finalPath = path.join(baseDir, hash);
  const tmpPath = `${finalPath}.part`;
  await fsp.writeFile(tmpPath, bytes, { mode: 0o600 });
  await fsp.rename(tmpPath, finalPath);
}

function renderSection(
  args: SlackConversationDocArgs,
  m: SlackMessage,
): string {
  const who = args.resolveUser(m.user ?? m.bot_id);
  return `**${who}** · ${fmt(tsToDate(m.ts))}\n\n${renderMrkdwn(m.text ?? '', args.resolveUser)}`;
}

const toMetaMessage =
  (args: SlackConversationDocArgs) => (m: SlackMessage) => ({
    id: m.ts,
    from: args.resolveUser(m.user ?? m.bot_id),
    date: tsToDate(m.ts).toISOString(),
    snippet: renderMrkdwn(m.text ?? '', args.resolveUser).slice(0, 200),
  });

async function upsertFiles(
  args: SlackConversationDocArgs,
  messages: SlackMessage[],
): Promise<DocumentId[]> {
  const ids: DocumentId[] = [];
  for (const m of messages) {
    for (const f of m.files ?? []) {
      if (!f.url_private || f.mode === 'tombstone') continue;
      const filename = f.name || f.title || f.id;
      const size = f.size ?? 0;
      let markdown: string | null = null;
      let convError: string | null = null;
      let bytes: Buffer = Buffer.alloc(0);
      // extraction_status: 'ok' once converted; otherwise a not-ok status that
      // the host's classifyDocument treats as a deep-extraction candidate.
      let status = 'unsupported';
      if (size > MAX_FILE_BYTES) {
        status = 'too_large';
      } else {
        bytes = await args
          .downloadFile(f.url_private)
          .catch(() => Buffer.alloc(0));
        if (bytes.length) {
          // Cache the raw bytes FIRST — independent of the convert outcome — so
          // the OCR/VLM pass can always re-read them via the byte source. The
          // in-tree builtin instead called ctx.enqueueExtraction (unavailable to
          // an out-of-process connector) and relied on a host-side re-download.
          try {
            await cacheBytes(args.mediaDir, sha256(bytes), bytes);
          } catch (e) {
            console.warn(
              `[slack] media cache write failed for ${f.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (args.converter) {
            try {
              const conv = await args.converter.convert({
                kind: 'bytes',
                bytes,
                mimeType: f.mimetype ?? '',
                filename,
              });
              markdown = conv?.markdown ?? null;
              convError = conv?.error ?? null;
              status = conv?.status ?? (markdown ? 'ok' : 'unsupported');
            } catch {
              // Converter backpressure / unsupported → leave markdown null and
              // let the host's deep-extraction pass handle it.
              markdown = null;
              status = 'unsupported';
            }
          }
        }
      }
      const fileDocId = await args.ctx.upsertDocument({
        source: 'slack',
        source_id: f.id,
        type: 'file',
        title: filename,
        markdown,
        metadata: {
          account_id: Number(args.accountId),
          filename,
          mime_type: f.mimetype ?? '',
          size_bytes: size,
          extraction_status: markdown ? 'ok' : status,
          extraction_error: convError,
          slack_channel_id: args.channelId,
          url_private: f.url_private,
        },
        source_url: archiveUrl(args.teamUrl, args.channelId, m.ts),
        content_hash: bytes.length ? sha256(bytes) : undefined,
        created_at: tsToDate(m.ts),
      });
      ids.push(fileDocId);
      // NO enqueueExtraction: a `file` doc with markdown===null is auto-enrolled
      // into deep-extraction by the host inside upsertDocument (classifyDocument).
    }
  }
  // The same Slack file id can be shared in several messages of one batch —
  // the upsert returns the same doc id each time, so dedupe before the ids
  // become doc:// links and attachment_ids entries.
  return [...new Set(ids)];
}

function baseMetadata(
  args: SlackConversationDocArgs,
  msgs: SlackMessage[],
  fileIds: DocumentId[],
): Record<string, unknown> {
  return {
    account_id: Number(args.accountId),
    slack_channel_id: args.channelId,
    slack_channel_name: args.channelName,
    conversation_type: args.kind,
    message_count: msgs.length,
    participants: [
      ...new Set(msgs.map((m) => args.resolveUser(m.user ?? m.bot_id))),
    ],
    first_message_at: tsToDate(msgs[0].ts).toISOString(),
    last_message_at: tsToDate(msgs.at(-1)!.ts).toISOString(),
    messages: msgs.map(toMetaMessage(args)),
    attachment_ids: fileIds.map(Number),
  };
}

/** One document per thread: root + replies, ascending. Re-upsert on new replies. */
export async function upsertSlackThread(
  args: SlackConversationDocArgs,
  messages: SlackMessage[],
): Promise<DocumentId | null> {
  const msgs = [...messages]
    .filter(indexable)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!msgs.length) return null;
  const root = msgs[0];
  const threadTs = root.thread_ts ?? root.ts;
  const fileIds = await upsertFiles(args, msgs);
  const sections = [
    `# ${args.channelName} — thread`,
    `> ${msgs.length} messages · ${fmt(tsToDate(msgs[0].ts))} → ${fmt(tsToDate(msgs.at(-1)!.ts))}`,
    '---',
    ...msgs.map((m) => renderSection(args, m)),
    ...fileIds.map((id) => `[File](doc://${id})`),
  ];
  const markdown = sections.join('\n\n');
  const rootText = renderMrkdwn(root.text ?? '', args.resolveUser).trim();
  return args.ctx.upsertDocument({
    source: 'slack',
    source_id: `${args.channelId}:${threadTs}`,
    type: 'slack_thread',
    title: `${args.channelName}: ${(rootText || '(no text)').slice(0, 80)}`,
    markdown,
    metadata: {
      ...baseMetadata(args, msgs, fileIds),
      slack_thread_ts: threadTs,
    },
    source_url: archiveUrl(args.teamUrl, args.channelId, threadTs),
    content_hash: sha256(markdown),
    from_address: args.resolveUser(root.user ?? root.bot_id).toLowerCase(),
    created_at: tsToDate(root.ts),
  });
}

/** Full (re)write of a channel-day doc — backfill path. */
export async function upsertChannelDay(
  args: SlackConversationDocArgs,
  day: string,
  messages: SlackMessage[],
): Promise<DocumentId | null> {
  const msgs = [...messages]
    .filter(indexable)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!msgs.length) return null;
  const fileIds = await upsertFiles(args, msgs);
  const sections = [
    `# ${args.channelName} — ${day}`,
    '---',
    ...msgs.map((m) => renderSection(args, m)),
    ...fileIds.map((id) => `[File](doc://${id})`),
  ];
  const markdown = sections.join('\n\n');
  return args.ctx.upsertDocument({
    source: 'slack',
    source_id: `${args.channelId}:${day}`,
    type: 'slack_channel_day',
    title: `${args.channelName} — ${day}`,
    markdown,
    metadata: baseMetadata(args, msgs, fileIds),
    source_url: archiveUrl(args.teamUrl, args.channelId, msgs[0].ts),
    content_hash: sha256(markdown),
    from_address: args
      .resolveUser(msgs[0].user ?? msgs[0].bot_id)
      .toLowerCase(),
    created_at: tsToDate(msgs[0].ts),
  });
}

/**
 * Delta path: merge new messages into an existing day doc. Dedupe by ts
 * (metadata.messages[].id) so cursor-lookback re-reads never duplicate.
 */
export async function appendToChannelDay(
  args: SlackConversationDocArgs,
  day: string,
  messages: SlackMessage[],
): Promise<DocumentId | null> {
  const msgs = [...messages]
    .filter(indexable)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!msgs.length) return null;
  const sourceId = `${args.channelId}:${day}`;
  const existing = await args.ctx.findBySourceId(
    'slack',
    sourceId,
    'slack_channel_day',
  );
  if (!existing) return upsertChannelDay(args, day, msgs);

  const meta = existing.metadata as {
    messages?: Array<{
      id: string;
      from: string;
      date: string;
      snippet: string;
    }>;
    participants?: string[];
    attachment_ids?: number[];
  };
  const seen = new Set((meta.messages ?? []).map((x) => x.id));
  const fresh = msgs.filter((x) => !seen.has(x.ts));
  if (!fresh.length) return existing.id;

  const fileIds = await upsertFiles(args, fresh);
  const sections = [
    ...fresh.map((x) => renderSection(args, x)),
    ...fileIds.map((id) => `[File](doc://${id})`),
  ];
  const markdown = `${existing.markdown ?? ''}\n\n${sections.join('\n\n')}`;
  const mergedMsgs = [
    ...(meta.messages ?? []),
    ...fresh.map(toMetaMessage(args)),
  ];
  return args.ctx.upsertDocument({
    source: 'slack',
    source_id: sourceId,
    type: 'slack_channel_day',
    title: existing.title,
    markdown,
    metadata: {
      ...existing.metadata,
      message_count: mergedMsgs.length,
      participants: [
        ...new Set([
          ...(meta.participants ?? []),
          ...fresh.map((x) => args.resolveUser(x.user ?? x.bot_id)),
        ]),
      ],
      last_message_at: tsToDate(fresh.at(-1)!.ts).toISOString(),
      messages: mergedMsgs,
      attachment_ids: [
        ...new Set([...(meta.attachment_ids ?? []), ...fileIds.map(Number)]),
      ],
    },
    source_url: existing.source_url,
    content_hash: sha256(markdown),
    from_address: existing.from_address,
    created_at: existing.created_at,
  });
}
