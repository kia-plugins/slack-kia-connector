/** @jest-environment node */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendToChannelDay,
  archiveUrl,
  upsertChannelDay,
  upsertSlackThread,
  type SlackConversationDocArgs,
} from '../thread-builder';
import { makeSlackByteSource } from '../byte-source';
import { captureHost, fakeConverter, type CaptureHost } from './mocks';
import type { Converter } from '../host';
import type { SlackMessage } from '../types';

const sha256 = (b: Buffer | string) =>
  crypto.createHash('sha256').update(b).digest('hex');

function mkArgs(
  h: CaptureHost,
  over: Partial<SlackConversationDocArgs> = {},
): SlackConversationDocArgs {
  return {
    ctx: h.ctx,
    converter: undefined,
    mediaDir: '/tmp/slack-test/slack/media',
    accountId: 1n,
    teamUrl: 'https://acme.slack.com/',
    channelId: 'C1',
    channelName: '#general',
    kind: 'public_channel',
    resolveUser: (id) => (id === 'U1' ? 'Alice' : (id ?? 'unknown')),
    downloadFile: async () => Buffer.alloc(0),
    ...over,
  };
}

const msg = (over: Partial<SlackMessage> & { ts: string }): SlackMessage => ({
  type: 'message',
  user: 'U1',
  text: 'hello',
  ...over,
});

describe('archiveUrl', () => {
  it('builds a permalink from team url + channel + ts', () => {
    expect(archiveUrl('https://acme.slack.com/', 'C1', '1700000000.000100')).toBe(
      'https://acme.slack.com/archives/C1/p1700000000000100',
    );
  });
});

describe('upsertChannelDay', () => {
  it('writes one slack_channel_day doc with rendered sections + metadata', async () => {
    const h = captureHost();
    const id = await upsertChannelDay(mkArgs(h), '2026-01-02', [
      msg({ ts: '1735776000.000100', text: 'first' }),
      msg({ ts: '1735776100.000200', text: 'second', user: 'U2' }),
    ]);
    expect(id).toBe(1n);
    expect(h.docs).toHaveLength(1);
    const doc = h.docs[0];
    expect(doc.source).toBe('slack');
    expect(doc.source_id).toBe('C1:2026-01-02');
    expect(doc.type).toBe('slack_channel_day');
    expect(doc.title).toBe('#general — 2026-01-02');
    expect(doc.markdown).toContain('# #general — 2026-01-02');
    expect(doc.markdown).toContain('first');
    expect(doc.markdown).toContain('second');
    expect(doc.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.metadata).toMatchObject({
      slack_channel_id: 'C1',
      conversation_type: 'public_channel',
      message_count: 2,
    });
  });

  it('returns null when there are no indexable messages', async () => {
    const h = captureHost();
    const id = await upsertChannelDay(mkArgs(h), '2026-01-02', [
      msg({ ts: '1', text: '', subtype: 'channel_join' }),
    ]);
    expect(id).toBeNull();
    expect(h.docs).toHaveLength(0);
  });
});

describe('upsertSlackThread', () => {
  it('writes a slack_thread doc keyed by channel:thread_ts', async () => {
    const h = captureHost();
    const id = await upsertSlackThread(mkArgs(h), [
      msg({ ts: '100.0001', thread_ts: '100.0001', text: 'root' }),
      msg({ ts: '101.0002', thread_ts: '100.0001', text: 'reply', user: 'U2' }),
    ]);
    expect(id).toBe(1n);
    const doc = h.docs[0];
    expect(doc.type).toBe('slack_thread');
    expect(doc.source_id).toBe('C1:100.0001');
    expect(doc.markdown).toContain('# #general — thread');
    expect(doc.metadata).toMatchObject({ slack_thread_ts: '100.0001' });
  });
});

describe('appendToChannelDay', () => {
  it('dedupes by ts and merges fresh messages into an existing day doc', async () => {
    const h = captureHost();
    const args = mkArgs(h);
    await upsertChannelDay(args, '2026-01-02', [
      msg({ ts: '1735776000.0001', text: 'm1' }),
    ]);
    // Re-deliver m1 (cursor lookback overlap) plus a new m2.
    const id = await appendToChannelDay(args, '2026-01-02', [
      msg({ ts: '1735776000.0001', text: 'm1' }),
      msg({ ts: '1735776100.0002', text: 'm2' }),
    ]);
    expect(id).toBe(1n); // same doc id (upsert)
    const last = h.docs.at(-1)!;
    expect(last.metadata).toMatchObject({ message_count: 2 });
    expect(last.markdown).toContain('m1');
    expect(last.markdown).toContain('m2');
    // m1 must not be duplicated in the rendered body.
    expect(last.markdown!.match(/m1/g)).toHaveLength(1);
  });
});

describe('file handling (converter + cache + deep-extraction enrollment)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-files-'));
  const mediaCache = path.join(dataDir, 'slack', 'media');

  it('converts a supported file inline → markdown + extraction_status ok', async () => {
    const h = captureHost();
    const bytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    const conv: Converter = fakeConverter({ markdown: 'PDF TEXT', status: 'ok' });
    const args = mkArgs(h, {
      converter: conv,
      mediaDir: mediaCache,
      downloadFile: async () => bytes,
    });

    await upsertChannelDay(args, '2026-01-02', [
      msg({
        ts: '100.1',
        text: 'see file',
        files: [
          {
            id: 'F1',
            name: 'doc.pdf',
            mimetype: 'application/pdf',
            size: bytes.length,
            url_private: 'https://files.slack.com/F1',
          },
        ],
      }),
    ]);

    const fileDoc = h.docs.find((d) => d.type === 'file')!;
    expect(fileDoc.markdown).toBe('PDF TEXT');
    expect(fileDoc.content_hash).toBe(sha256(bytes));
    expect(fileDoc.metadata).toMatchObject({
      extraction_status: 'ok',
      mime_type: 'application/pdf',
      filename: 'doc.pdf',
    });
    // Bytes cached so the OCR pass / byte source can re-read them.
    expect(fs.existsSync(path.join(mediaCache, sha256(bytes)))).toBe(true);
  });

  it('emits a null-markdown file doc for an unconvertible image (auto-enrolled) and caches its bytes', async () => {
    const h = captureHost();
    const bytes = Buffer.from('\x89PNG fake image bytes here');
    const conv: Converter = fakeConverter({
      markdown: null,
      status: 'unsupported',
    });
    const args = mkArgs(h, {
      converter: conv,
      mediaDir: mediaCache,
      downloadFile: async () => bytes,
    });

    await upsertChannelDay(args, '2026-01-03', [
      msg({
        ts: '200.1',
        text: 'pic',
        files: [
          {
            id: 'F2',
            name: 'photo.png',
            mimetype: 'image/png',
            size: bytes.length,
            url_private: 'https://files.slack.com/F2',
          },
        ],
      }),
    ]);

    const fileDoc = h.docs.find((d) => d.source_id === 'F2')!;
    // null markdown is the auto-enroll signal: the host's classifyDocument enrolls
    // it into deep-extraction inside upsertDocument — NO enqueueExtraction call.
    expect(fileDoc.markdown).toBeNull();
    expect(fileDoc.metadata).toMatchObject({ extraction_status: 'unsupported' });
    expect(fileDoc.content_hash).toBe(sha256(bytes));

    // Round-trip: the byte source reads the cached bytes back by content_hash.
    const src = makeSlackByteSource(dataDir);
    const r = await src.fetch({} as never, { content_hash: sha256(bytes) } as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.equals(bytes)).toBe(true);
  });

  it('marks an oversize file too_large with no bytes and no content_hash', async () => {
    const h = captureHost();
    const args = mkArgs(h, {
      converter: fakeConverter({ markdown: null, status: 'unsupported' }),
      mediaDir: mediaCache,
      downloadFile: async () => {
        throw new Error('must not download an oversize file');
      },
    });
    await upsertChannelDay(args, '2026-01-04', [
      msg({
        ts: '300.1',
        text: 'big',
        files: [
          {
            id: 'F3',
            name: 'huge.pdf',
            mimetype: 'application/pdf',
            size: 60 * 1024 * 1024,
            url_private: 'https://files.slack.com/F3',
          },
        ],
      }),
    ]);
    const fileDoc = h.docs.find((d) => d.source_id === 'F3')!;
    expect(fileDoc.markdown).toBeNull();
    expect(fileDoc.content_hash).toBeUndefined();
    expect(fileDoc.metadata).toMatchObject({ extraction_status: 'too_large' });
  });
});
