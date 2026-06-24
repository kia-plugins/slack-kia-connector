import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ByteSource } from '@alpha-cent/connector-sdk';
import type { Db } from './host';
import { mediaDir } from './media-dir';

type Candidate = {
  documentId?: bigint;
  content_hash?: string;
  source?: string;
};

/** Reads Slack file bytes from the local content-addressed cache by
 *  content_hash. No network: a miss is terminal ('gone'). dataRoot is the
 *  host's shared data root; we namespace under slack/media (mediaDir).
 *
 *  Out-of-process connectors cannot call the host's enqueueExtraction, so the
 *  thread-builder emits null-markdown `file` docs (auto-enrolled into
 *  deep-extraction by the host) AND caches the raw bytes here so the OCR/VLM
 *  pass can re-read them by content_hash without re-downloading from Slack. */
export function makeSlackByteSource(dataRoot: string): ByteSource {
  const dir = mediaDir(dataRoot);
  return {
    source: 'slack',
    async fetch(dbUnknown, candidateUnknown) {
      const db = dbUnknown as Db;
      const c = (candidateUnknown ?? {}) as Candidate;
      let hash = c.content_hash;
      if (!hash && c.documentId != null) {
        try {
          const rows = await db.all(
            `SELECT content_hash FROM documents WHERE id=?`,
            [c.documentId],
          );
          const h = rows[0]?.content_hash;
          if (typeof h === 'string' && h) hash = h;
        } catch {
          /* fall through */
        }
      }
      if (!hash) return { ok: false, kind: 'gone', detail: 'no content_hash' };
      try {
        return { ok: true, bytes: await fsp.readFile(path.join(dir, hash)) };
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT')
          return { ok: false, kind: 'gone', detail: 'not in slack media cache' };
        return { ok: false, kind: 'unavailable', detail: code ?? 'read failed' };
      }
    },
  };
}
