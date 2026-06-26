import type {
  ConnectorHost,
  Document,
  DocumentId,
  PendingDocument,
  SyncStateRow,
} from '@kiagent/connector-sdk';
import type { Converter } from '../host';

/** Reversible stand-in for Electron safeStorage (tests have no keyring). */
export function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  };
}

/** A Converter stand-in returning a fixed result and recording its calls. */
export function fakeConverter(
  result: Awaited<ReturnType<Converter['convert']>>,
): Converter & { calls: Array<{ mimeType?: string; filename?: string }> } {
  const calls: Array<{ mimeType?: string; filename?: string }> = [];
  return {
    calls,
    async convert(input) {
      if (input.kind === 'bytes')
        calls.push({ mimeType: input.mimeType, filename: input.filename });
      return result;
    },
  };
}

export interface CaptureHost {
  ctx: ConnectorHost;
  docs: PendingDocument[];
  archived: Array<{ id: bigint; reason: string }>;
  box: { state: Partial<SyncStateRow> | null };
}

/**
 * A ConnectorHost that records upsertDocument / archive / sync-state calls and
 * implements upsert+findBySourceId semantics over an in-memory store (so the
 * delta append path can read back a previously-written day doc).
 */
export function captureHost(
  opts: {
    db?: unknown;
    dataDir?: string;
    converter?: unknown;
    state?: Partial<SyncStateRow> | null;
  } = {},
): CaptureHost {
  const docs: PendingDocument[] = [];
  const archived: Array<{ id: bigint; reason: string }> = [];
  const store = new Map<string, Document>();
  const box: { state: Partial<SyncStateRow> | null } = {
    state: opts.state ?? null,
  };
  let nextId = 1n;
  const ctx = {
    accountId: 1n,
    db: opts.db,
    converter: opts.converter,
    dataDir: opts.dataDir ?? '/tmp/slack-test',
    safeStorage: fakeSafeStorage(),
    emitStreamEvent: () => {},
    async upsertDocument(doc: PendingDocument): Promise<DocumentId> {
      docs.push(doc);
      const key = `${doc.source}:${doc.source_id}:${doc.type}`;
      const prior = store.get(key);
      const id = prior?.id ?? nextId++;
      const now = new Date();
      store.set(key, {
        ...doc,
        id,
        ingested_at: prior?.ingested_at ?? now,
        updated_at: now,
      });
      return id;
    },
    async deleteDocument() {},
    async archiveDocument(id: bigint, reason: string) {
      archived.push({ id, reason });
    },
    async findBySourceId(source: string, sourceId: string, type: string) {
      return store.get(`${source}:${sourceId}:${type}`) ?? null;
    },
    async findByContentHash() {
      return [];
    },
    async saveSyncState(s: Partial<SyncStateRow>) {
      box.state = { ...(box.state ?? {}), ...s };
    },
    async loadSyncState() {
      return box.state as SyncStateRow | null;
    },
  } as unknown as ConnectorHost;
  return { ctx, docs, archived, box };
}

/** Build a fetch stand-in for Slack auth.test, with controllable scopes/body. */
export function fakeAuthTestFetch(opts: {
  ok?: boolean;
  status?: number;
  scopes?: string[];
  body?: Record<string, unknown>;
}) {
  const headers = new Map<string, string>([
    ['x-oauth-scopes', (opts.scopes ?? []).join(',')],
  ]);
  return jest.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => opts.body ?? { ok: true },
  }));
}
