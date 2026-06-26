import type {
  Account,
  Connector,
  ConnectorInstance,
  ConnectorHost,
} from '@kiagent/connector-sdk';
import type { Converter } from './host';
import { loadTokenBlob } from './safe-storage-blob';
import { decodeSlackTokenFromStorage } from './token';
import { SlackClient } from './client';
import { SlackUserDirectory } from './users';
import { runSlackBackfill } from './backfill';
import { runSlackDelta } from './delta';
import { archiveUrl } from './thread-builder';
import { makeSlackByteSource } from './byte-source';
import { submitSlack } from './submit';

export const connector: Connector = {
  id: 'slack',
  displayName: 'Slack',
  capabilities: {
    multiAccount: true,
    requiresAuth: true,
    supportsBackfill: true,
    supportsDelta: true,
    supportsRealtime: false,
  },
  getAccountSchema: () => ({
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string', title: 'User OAuth token (xoxp-…)' },
    },
  }),
  validateAccount: (input) => {
    const i = input as Partial<{ token: string }>;
    if (!i?.token?.startsWith('xoxp-'))
      return { ok: false, error: 'a user OAuth token (xoxp-…) is required' };
    return { ok: true };
  },
  createInstance,
};

async function createInstance(
  account: Account,
  ctx: ConnectorHost,
): Promise<ConnectorInstance> {
  const token = decodeSlackTokenFromStorage(
    loadTokenBlob(account.credentials_blob_path!),
    ctx.safeStorage,
  );
  const client = new SlackClient({ getToken: () => token.access_token });
  const users = new SlackUserDirectory(client);
  // ctx.converter may be undefined in some host contexts; thread-builder guards
  // it and leaves file markdown null for the deep-extraction pass.
  const converter = ctx.converter as Converter | undefined;
  const abort = new AbortController();
  const common = {
    ctx,
    converter,
    client,
    users,
    accountId: account.id,
    token,
  };

  return {
    async startBackfill(progress) {
      await runSlackBackfill({
        ...common,
        signal: abort.signal,
        onProgress: (done, total) => progress.update(done, total),
      });
    },
    async pollDelta() {
      await runSlackDelta(common);
    },
    requestStop() {
      abort.abort();
    },
    async shutdown() {},
    buildSourceUrl(sourceId, type, metadata) {
      const channel =
        (metadata.slack_channel_id as string | undefined) ??
        sourceId.split(':')[0];
      if (type === 'slack_thread')
        return archiveUrl(
          token.team_url,
          channel,
          sourceId.split(':')[1] ?? '',
        );
      return `${token.team_url.replace(/\/$/, '')}/archives/${channel}`;
    },
  };
}

// Only the manifest-referenced submit hook is exported, mirroring the in-tree
// builtin's registration `mod(slackConnector, { 'slack-submit': submitSlack })`.
// The loader rejects "orphan" hooks (declared but unreferenced); the
// input-fields `slack-token` validation and the show-copyable Slack-app manifest
// content are both resolved renderer-side, not as backend hooks.
export const hooks = {
  'slack-submit': submitSlack,
};

export function makeByteSource(deps: { dataDir: string }) {
  return makeSlackByteSource(deps.dataDir);
}

export default { connector, hooks, makeByteSource };
module.exports = { connector, hooks, makeByteSource };
