/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestDb } from './harness';
import { makeSlackByteSource } from '../byte-source';

describe('makeSlackByteSource', () => {
  // base is the host's shared data root; the source reads the content-addressed
  // cache under <base>/slack/media (mediaDir(base)).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-bs-'));
  const mediaCacheDir = path.join(base, 'slack', 'media');
  fs.mkdirSync(mediaCacheDir, { recursive: true });
  const src = makeSlackByteSource(base);

  it('declares source slack', () => {
    expect(src.source).toBe('slack');
  });

  it('reads bytes from the cache by content_hash', async () => {
    fs.writeFileSync(path.join(mediaCacheDir, 'deadbeef'), 'PNGDATA');
    const r = await src.fetch({} as never, { content_hash: 'deadbeef' } as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.toString()).toBe('PNGDATA');
  });

  it('returns gone when the file was cleaned up', async () => {
    const r = await src.fetch({} as never, { content_hash: 'missing' } as never);
    expect(r).toMatchObject({ ok: false, kind: 'gone' });
  });

  it('returns unavailable (retryable) on a transient FS error', async () => {
    // A non-ENOENT read failure must be retryable, not terminal. Point at a
    // directory named like the content_hash so readFile throws EISDIR.
    fs.mkdirSync(path.join(mediaCacheDir, 'adir'));
    const r = await src.fetch({} as never, { content_hash: 'adir' } as never);
    expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('falls back to the documents.content_hash column by id', async () => {
    // The real drain candidate does NOT carry content_hash, so the source must
    // resolve it from the documents column via the doc id.
    const db = openTestDb();
    try {
      fs.writeFileSync(path.join(mediaCacheDir, 'cafef00d'), 'JPEGDATA');
      await db.run(
        `INSERT INTO documents (source,source_id,type,title,markdown,metadata,source_url,content_hash,created_at,ingested_at,updated_at)
         VALUES ('slack','c:9','file','pic',NULL,'{}','','cafef00d','t','t','t')`,
      );
      const id = (
        await db.all(`SELECT id FROM documents WHERE content_hash='cafef00d'`)
      )[0].id as bigint;
      const r = await src.fetch(db, { documentId: id } as never);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.bytes.toString()).toBe('JPEGDATA');
    } finally {
      await db.close();
    }
  });
});
