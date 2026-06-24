-- src/main/db/schema.sql
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  type         TEXT NOT NULL,
  parent_id    INTEGER,
  title        TEXT,
  markdown     TEXT,
  metadata     TEXT,
  source_url   TEXT NOT NULL,
  content_hash TEXT,
  from_address TEXT,
  -- Owning accounts.id. Written by ConnectorContextImpl.upsertDocument; old
  -- rows are backfilled per-source by backfillDocumentAccountIds (migration).
  -- NULL = ownership could not be derived (orphaned by pre-column conventions).
  account_id   INTEGER,
  created_at   TEXT,
  ingested_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT,
  UNIQUE(source, source_id, type)
);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
-- idx_documents_account_id (source, account_id) is created by migrations.ts
-- AFTER the additive ALTER, so old DBs don't fail here with "no such column".
CREATE INDEX IF NOT EXISTS idx_documents_source_type  ON documents(source, type);
CREATE INDEX IF NOT EXISTS idx_documents_from_address ON documents(from_address);

CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY,
  source                TEXT NOT NULL,
  identifier            TEXT NOT NULL,
  display_name          TEXT,
  config_json           TEXT,
  credentials_blob_path TEXT,
  enabled               INTEGER DEFAULT 1,
  created_at            TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source, identifier)
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id              INTEGER PRIMARY KEY,
  status                  TEXT,
  backfill_total_estimate INTEGER,
  backfill_done_count     INTEGER,
  cursor_json             TEXT,
  last_sync_at            TEXT,
  last_error              TEXT
);

CREATE TABLE IF NOT EXISTS tracked_roots (
  id                TEXT PRIMARY KEY,
  account_id        INTEGER,
  kind              TEXT NOT NULL DEFAULT 'fs' CHECK (kind IN ('fs','drive','ms-drive','browser')),
  abs_path          TEXT,
  external_id       TEXT,
  display_path      TEXT,
  include_glob      TEXT,
  exclude_glob      TEXT,
  last_full_scan_at TEXT,
  added_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (kind='fs'       AND abs_path    IS NOT NULL) OR
    (kind='drive'    AND external_id IS NOT NULL) OR
    (kind='ms-drive' AND external_id IS NOT NULL) OR
    (kind='browser'  AND abs_path    IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS drive_folder_index (
  account_id      INTEGER NOT NULL,
  file_id         TEXT    NOT NULL,
  parent_id       TEXT,
  is_folder       INTEGER NOT NULL,
  tracked_root_id TEXT,
  PRIMARY KEY (account_id, file_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_drive_folder_index_parent
  ON drive_folder_index(account_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_drive_folder_index_root
  ON drive_folder_index(account_id, tracked_root_id)
  WHERE tracked_root_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_embeddings (
  document_id  INTEGER PRIMARY KEY,
  model        TEXT,
  embedding    BLOB
);

-- Deep-extraction backlog. One row per document the first-pass converter left
-- text-poor (images, scanned PDFs). `state` drives the OCR+VLM queue built in
-- later sub-projects; this sub-project only ever writes 'pending' and 'skipped'.
-- `content_hash` is documents.content_hash at evaluation time, so a re-ingest
-- with changed bytes can be detected and requeued.
CREATE TABLE IF NOT EXISTS deep_extractions (
  document_id  INTEGER PRIMARY KEY,
  state        TEXT NOT NULL,
  reason       TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  engine       TEXT,
  content_hash TEXT,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_deep_extractions_state ON deep_extractions(state);
-- Serves the scheduler's oldest-first claim (state='pending' ORDER BY
-- created_at). The single-column state index above is kept: dropping it on
-- existing DBs would need migration code for negligible win.
CREATE INDEX IF NOT EXISTS idx_deep_extractions_state_created
  ON deep_extractions(state, created_at);

CREATE TABLE IF NOT EXISTS annotations (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER,
  kind         TEXT,
  author       TEXT,
  content      TEXT,
  metadata     TEXT,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT
);

-- Full-text index: stemmed search views, per-field weighting via bm25().
-- rowid = documents.id. Populated by ConnectorContextImpl.upsertDocument.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, from_address, body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Trigram index: substring/fuzzy fallback over raw body text.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_tri USING fts5(
  body,
  tokenize = 'trigram'
);

-- Per-document detected languages (1-to-many). A document can carry several
-- languages, e.g. an email thread with both a German body and an English
-- signature. `lang` is an ISO 639-3 code (or 'und' = scanned, undetermined);
-- `score` is the proportion of identified text in that language (0..1).
-- Populated by ConnectorContextImpl.upsertDocument and backfillLanguages.
CREATE TABLE IF NOT EXISTS document_languages (
  document_id INTEGER NOT NULL,
  lang        TEXT NOT NULL,
  score       REAL NOT NULL,
  PRIMARY KEY (document_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_document_languages_lang ON document_languages(lang);

-- ---------------------------------------------------------------------------
-- OAuth 2.1 Authorization Server (oidc-provider) state.
-- Single table with `type` discriminator stores all 7 oidc-provider entities:
-- Client, AccessToken, RefreshToken, AuthorizationCode, Interaction, Grant,
-- Session, DeviceCode, etc. All ephemeral with expires_at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oidc_payload (
  type        TEXT NOT NULL,
  id          TEXT NOT NULL,
  uid         TEXT,                      -- for Interaction.findByUid
  user_code   TEXT,                      -- for DeviceCode.findByUserCode
  grant_id    TEXT,                      -- for revokeByGrantId
  payload     TEXT NOT NULL,             -- JSON blob
  expires_at  INTEGER,                   -- unix seconds; null = no expiry
  consumed_at INTEGER,                   -- unix seconds; null = not consumed
  PRIMARY KEY (type, id)
);

CREATE INDEX IF NOT EXISTS idx_oidc_uid       ON oidc_payload(type, uid);
CREATE INDEX IF NOT EXISTS idx_oidc_user_code ON oidc_payload(type, user_code);
CREATE INDEX IF NOT EXISTS idx_oidc_grant_id  ON oidc_payload(type, grant_id);
CREATE INDEX IF NOT EXISTS idx_oidc_expires   ON oidc_payload(expires_at);

-- ---------------------------------------------------------------------------
-- Per-account polling cadence overrides, keyed by accounts.id. Rows are
-- written by the 'connector:set-cadence' IPC. Missing rows fall back to the
-- scheduler's compiled-in DEFAULT_CADENCE_MS, so deleting a row reverts to
-- defaults. Existing source-keyed profiles are migrated by
-- rekeyConnectorCadenceToAccount (src/main/db/migrations.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_cadence (
  account_id   INTEGER PRIMARY KEY,
  focused_ms   INTEGER NOT NULL,
  unfocused_ms INTEGER NOT NULL,
  updated_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- IMAP connector thread-membership index. Account-scoped. Lets a thread doc be
-- re-assembled whenever any member message is added/changed/removed. Additive;
-- created here so runInitialMigration (which execs this file every boot) keeps
-- both fresh and existing DBs in sync without a separate ALTER.
CREATE TABLE IF NOT EXISTS imap_message_index (
  account_id      INTEGER NOT NULL,
  folder          TEXT    NOT NULL,
  uid             INTEGER NOT NULL,
  uidvalidity     INTEGER NOT NULL,
  message_id      TEXT    NOT NULL,
  thread_key      TEXT    NOT NULL,
  date            TEXT    NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_imap_thread
  ON imap_message_index (account_id, thread_key);
CREATE INDEX IF NOT EXISTS idx_imap_msgid
  ON imap_message_index (account_id, message_id);
CREATE INDEX IF NOT EXISTS idx_imap_subject
  ON imap_message_index (account_id, thread_key, date);
