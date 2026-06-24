/**
 * The user creates their OWN internal Slack app from this manifest. Internal
 * customer-built apps are exempt from the 2025/2026 non-Marketplace rate
 * limits on conversations.history/replies (1 req/min, 15 msgs) and keep Tier 3
 * (~50 req/min, up to 1000 msgs/request) — a bundled OAuth app would be
 * unusable for backfill.
 *
 * SLACK_USER_SCOPES is the source of truth for the scopes the token must carry
 * (validated in add-account.ts). SLACK_APP_MANIFEST is the YAML the user pastes
 * into api.slack.com; the same text is inlined verbatim as the wizard's
 * show-copyable step content in manifest.json (keep them in sync if edited).
 */
export const SLACK_USER_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
  'files:read',
] as const;

const scopeLines = SLACK_USER_SCOPES.map((s) => `      - ${s}`).join('\n');

export const SLACK_APP_MANIFEST = `display_information:
  name: KIAgent
  description: Personal digital memory indexing (runs locally on your Mac)
oauth_config:
  scopes:
    user:
${scopeLines}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

export const SLACK_CREATE_APP_URL = 'https://api.slack.com/apps?new_app=1';
