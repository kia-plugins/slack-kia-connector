import type { Db } from './host';

export interface UpsertAccountInput {
  source: string;
  /** UNIQUE(source, identifier) key — for Notion the bot_id. */
  identifier: string;
  displayName: string;
  /** Path of the freshly written encrypted token blob. */
  credsPath: string;
}

/**
 * Upserts the accounts row for a (source, identifier) pair and resets its
 * sync_state so the scheduler treats the account as a fresh start. Mirrors the
 * app's accounts/persist `upsertAccountWithFreshSyncState`, expressed over the
 * host's raw db surface because a forked extension can't import @main.
 *
 * Re-adding an existing workspace must clear the whole cursor: a stale cursor
 * (often status='live' with a delta window from the old token) would keep the
 * scheduler in delta mode and silently skip the backfill.
 */
export async function upsertAccountWithFreshSyncState(
  db: Db,
  input: UpsertAccountInput,
): Promise<bigint> {
  const { source, identifier, displayName, credsPath } = input;

  const existing = await db.all(
    `SELECT id FROM accounts WHERE source = ? AND identifier = ?`,
    [source, identifier],
  );
  let accountId: bigint;
  if (existing[0]) {
    accountId = existing[0].id as bigint;
    await db.run(
      `UPDATE accounts SET display_name = ?, credentials_blob_path = ? WHERE id = ?`,
      [displayName, credsPath, accountId],
    );
  } else {
    const inserted = await db.all(
      `INSERT INTO accounts (source, identifier, display_name, credentials_blob_path)
         VALUES (?, ?, ?, ?) RETURNING id`,
      [source, identifier, displayName, credsPath],
    );
    accountId = inserted[0].id as bigint;
  }

  // Full reset — upsert so it covers both the re-add (dirty row) and the
  // brand-new account (no row) branches above.
  await db.run(
    `INSERT INTO sync_state
       (account_id, status, backfill_total_estimate, backfill_done_count,
        cursor_json, last_sync_at, last_error)
       VALUES (?, 'pending', NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT(account_id) DO UPDATE SET
       status = 'pending',
       backfill_total_estimate = NULL,
       backfill_done_count = NULL,
       cursor_json = NULL,
       last_sync_at = NULL,
       last_error = NULL`,
    [accountId],
  );
  return accountId;
}

/** Best-effort delete of a half-created account (token-vault write failed). */
export async function deleteAccount(db: Db, accountId: bigint): Promise<void> {
  await db.run(`DELETE FROM sync_state WHERE account_id = ?`, [accountId]);
  await db.run(`DELETE FROM accounts WHERE id = ?`, [accountId]);
}
