import { SLACK_API_BASE } from './client';
import { SLACK_USER_SCOPES } from './manifest';
import type { SlackToken } from './types';

export type ValidateSlackResult =
  | { ok: true; token: SlackToken }
  | { ok: false; error: string; message: string };

export async function validateSlackToken(
  raw: string,
  fetchFn: typeof fetch = fetch,
): Promise<ValidateSlackResult> {
  const token = raw.trim();
  if (token.startsWith('xoxb-')) {
    return {
      ok: false,
      error: 'bot-token',
      message:
        'That is a Bot token (xoxb-…). Paste the User OAuth Token (xoxp-…) from the same OAuth & Permissions page.',
    };
  }
  if (!token.startsWith('xoxp-')) {
    return {
      ok: false,
      error: 'invalid-token-format',
      message: 'Expected a User OAuth Token starting with xoxp-.',
    };
  }
  let res: Awaited<ReturnType<typeof fetchFn>>;
  try {
    res = await fetchFn(`${SLACK_API_BASE}/auth.test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return {
      ok: false,
      error: 'network-failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!res.ok)
    return {
      ok: false,
      error: 'http-failed',
      message: `Slack returned HTTP ${res.status}`,
    };
  const granted = (res.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const j = (await res.json()) as {
    ok: boolean;
    error?: string;
    url?: string;
    team?: string;
    team_id?: string;
    user_id?: string;
  };
  if (!j.ok)
    return {
      ok: false,
      error: 'auth-failed',
      message: `Slack rejected the token: ${j.error ?? 'unknown error'}`,
    };
  const missing = SLACK_USER_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length)
    return {
      ok: false,
      error: 'missing-scope',
      message: `Token is missing scopes: ${missing.join(', ')}. Re-create the app from the current manifest and reinstall it to the workspace.`,
    };
  return {
    ok: true,
    token: {
      access_token: token,
      team_id: j.team_id!,
      user_id: j.user_id!,
      team_name: j.team ?? j.team_id!,
      team_url: j.url ?? 'https://app.slack.com/',
      scope: granted.join(' '),
    },
  };
}
