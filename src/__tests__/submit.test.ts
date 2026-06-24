import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectorSetupHost } from '@alpha-cent/connector-sdk';
import { submitSlack } from '../submit';
import { openTestDb } from './harness';
import { fakeSafeStorage, fakeAuthTestFetch } from './mocks';
import { SLACK_USER_SCOPES } from '../manifest';
import type { SlackToken } from '../types';

type Db = ReturnType<typeof openTestDb>;

function setupHost(
  db: Db,
  over: Partial<ConnectorSetupHost> & {
    hostSafeStorage?: ReturnType<typeof fakeSafeStorage>;
  } = {},
): { ctx: ConnectorSetupHost; oauthDir: string } {
  const oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-'));
  const hostSS = over.hostSafeStorage ?? fakeSafeStorage();
  const ctx = {
    oauthDir,
    db,
    safeStorage: { isEncryptionAvailable: () => true },
    hostFor: () => ({ safeStorage: hostSS }),
    restartAccount: async () => {},
    publishState: async () => {},
    ...over,
  } as unknown as ConnectorSetupHost;
  return { ctx, oauthDir };
}

const okFetch = () =>
  fakeAuthTestFetch({
    scopes: [...SLACK_USER_SCOPES],
    body: {
      ok: true,
      team: 'Acme',
      team_id: 'T123',
      user_id: 'U999',
      url: 'https://acme.slack.com/',
    },
  });

describe('submitSlack', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('creates an account, fresh sync_state, and an encrypted token blob', async () => {
    globalThis.fetch = okFetch() as never;
    const db = openTestDb();
    const { ctx } = setupHost(db);

    const r = await submitSlack({ token: 'xoxp-secret' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team).toBe('Acme');

    const accounts = await db.all(
      `SELECT id, identifier, display_name, credentials_blob_path AS p FROM accounts WHERE source='slack'`,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].identifier).toBe('T123');
    expect(accounts[0].display_name).toBe('Acme');

    const sync = await db.all(
      `SELECT status FROM sync_state WHERE account_id=?`,
      [accounts[0].id],
    );
    expect(sync[0].status).toBe('pending');

    const blob = fs.readFileSync(String(accounts[0].p));
    const token = JSON.parse(
      fakeSafeStorage().decryptString(blob),
    ) as SlackToken;
    expect(token.access_token).toBe('xoxp-secret');
    expect(token.team_id).toBe('T123');
    await db.close();
  });

  it('rejects a bot token without writing to the DB', async () => {
    const db = openTestDb();
    const { ctx } = setupHost(db);
    const r = await submitSlack({ token: 'xoxb-bot' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('bot-token');
    expect(await db.all(`SELECT id FROM accounts`)).toHaveLength(0);
    await db.close();
  });

  it('rolls back the account if the token vault write fails', async () => {
    globalThis.fetch = okFetch() as never;
    const db = openTestDb();
    const throwing = {
      ...fakeSafeStorage(),
      encryptString: () => {
        throw new Error('keyring locked');
      },
    };
    const { ctx } = setupHost(db, { hostSafeStorage: throwing });

    const r = await submitSlack({ token: 'xoxp-secret' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('vault-failed');
    // Account + sync_state must be rolled back so a retry starts clean.
    expect(await db.all(`SELECT id FROM accounts`)).toHaveLength(0);
    expect(await db.all(`SELECT account_id FROM sync_state`)).toHaveLength(0);
    await db.close();
  });
});
