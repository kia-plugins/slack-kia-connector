// Vendored from @kiagent/connector-sdk v1.1 (types only; never executed).
declare module '@kiagent/connector-sdk' {
  export type DocumentId = bigint;

  export interface PendingDocument {
    source: string;
    source_id: string;
    type: string;
    parent_id?: DocumentId;
    title: string;
    markdown: string | null;
    metadata: Record<string, unknown>;
    source_url: string;
    content_hash?: string;
    from_address?: string;
    created_at: Date;
  }
  export interface Document extends PendingDocument {
    id: DocumentId;
    ingested_at: Date;
    updated_at: Date;
  }
  export interface SyncStateRow {
    status: 'pending' | 'backfilling' | 'live' | 'error' | 'paused' | 'needs_reauth';
    backfill_total_estimate?: number;
    backfill_done_count?: number;
    cursor_json?: Record<string, unknown>;
    last_sync_at?: Date;
    last_error?: string;
  }
  export interface ConnectorCapabilities {
    multiAccount: boolean;
    requiresAuth: boolean;
    supportsBackfill: boolean;
    supportsDelta: boolean;
    supportsRealtime: boolean;
  }
  export interface Account {
    id: bigint;
    source: string;
    identifier: string;
    display_name?: string;
    config_json?: Record<string, unknown>;
    credentials_blob_path?: string;
    enabled: boolean;
  }
  export interface ProgressSink {
    update(done: number, totalEstimate: number | null): void;
    log(level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void;
  }
  export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(s: string): Buffer;
    decryptString(b: Buffer): string;
  }
  export interface ConnectorStreamEvent {
    connectorId: string;
    accountId: string;
    qr?: string;
    status?: string;
    error?: string;
  }
  export interface ByteSource {
    source: string;
    fetch(
      db: unknown,
      candidate: unknown,
    ): Promise<
      | { ok: true; bytes: Buffer }
      | { ok: false; kind: 'unavailable' | 'gone'; detail: string }
    >;
  }
  export interface ConnectorHost {
    readonly accountId: bigint;
    readonly db: unknown;
    readonly converter?: unknown;
    readonly dataDir: string;
    readonly safeStorage: SafeStorageLike;
    emitStreamEvent(event: ConnectorStreamEvent): void;
    upsertDocument(doc: PendingDocument): Promise<DocumentId>;
    deleteDocument(id: bigint): Promise<void>;
    archiveDocument(id: DocumentId, reason: string): Promise<void>;
    findBySourceId(source: string, sourceId: string, type: string): Promise<Document | null>;
    findByContentHash(hash: string): Promise<Document[]>;
    saveSyncState(state: Partial<SyncStateRow> & Pick<SyncStateRow, 'status'>): Promise<void>;
    loadSyncState(): Promise<SyncStateRow | null>;
  }
  export interface ConnectorSetupHost {
    readonly oauthDir: string;
    readonly db: unknown;
    readonly safeStorage: { isEncryptionAvailable(): boolean };
    publishState(): Promise<void>;
    restartAccountAndBroadcast(input: unknown): Promise<void>;
    pickFile(options: {
      title?: string;
      properties?: Array<'openFile' | 'openDirectory'>;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
    hostFor(accountId: bigint): ConnectorHost;
    restartAccount(accountId: bigint): Promise<void>;
    removeAccount(accountId: bigint): Promise<void>;
  }
  export interface ConnectorInstance {
    startBackfill(progress: ProgressSink): Promise<void>;
    pollDelta(): Promise<void>;
    startRealtime?(): Promise<void>;
    stopRealtime?(): Promise<void>;
    reconcile?(): Promise<void>;
    requestStop?(): void;
    shutdown(): Promise<void>;
    buildSourceUrl(sourceId: string, type: string, metadata: Record<string, unknown>): string;
  }
  export interface Connector {
    readonly id: string;
    readonly displayName: string;
    readonly capabilities: ConnectorCapabilities;
    getAccountSchema(): unknown;
    validateAccount(input: unknown): { ok: true } | { ok: false; error: string };
    createInstance(account: Account, ctx: ConnectorHost): Promise<ConnectorInstance>;
  }
  export interface ConnectorEntry {
    connector: Connector;
    hooks?: Record<string, (...args: never[]) => unknown>;
    makeByteSource?(deps: { dataDir: string }): ByteSource;
  }
}
