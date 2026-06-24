import { connector } from '../index';
import { validateSlackToken } from '../add-account';
import { SLACK_USER_SCOPES } from '../manifest';
import { fakeAuthTestFetch } from './mocks';

describe('connector descriptor', () => {
  it('has the expected id and capabilities', () => {
    expect(connector.id).toBe('slack');
    expect(connector.capabilities).toMatchObject({
      multiAccount: true,
      requiresAuth: true,
      supportsBackfill: true,
      supportsDelta: true,
      supportsRealtime: false,
    });
  });

  it('getAccountSchema requires a token', () => {
    const schema = connector.getAccountSchema() as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['token']);
    expect(schema.properties).toHaveProperty('token');
  });

  it('validateAccount rejects non-xoxp tokens and accepts xoxp-', () => {
    expect(connector.validateAccount({ token: 'nope' }).ok).toBe(false);
    expect(connector.validateAccount({}).ok).toBe(false);
    expect(connector.validateAccount({ token: 'xoxb-bot' }).ok).toBe(false);
    expect(connector.validateAccount({ token: 'xoxp-abc' }).ok).toBe(true);
  });
});

describe('validateSlackToken', () => {
  it('rejects a bot token (xoxb-) without calling the network', async () => {
    const fetchFn = jest.fn();
    const r = await validateSlackToken('xoxb-123', fetchFn as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('bot-token');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a wrong-format token without calling the network', async () => {
    const fetchFn = jest.fn();
    const r = await validateSlackToken('ntn_notslack', fetchFn as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid-token-format');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns the token identity on a 200 with all required scopes', async () => {
    const fetchFn = fakeAuthTestFetch({
      scopes: [...SLACK_USER_SCOPES],
      body: {
        ok: true,
        team: 'Acme',
        team_id: 'T123',
        user_id: 'U999',
        url: 'https://acme.slack.com/',
      },
    });
    const r = await validateSlackToken('xoxp-secret', fetchFn as never);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.token).toMatchObject({
        access_token: 'xoxp-secret',
        team_id: 'T123',
        user_id: 'U999',
        team_name: 'Acme',
        team_url: 'https://acme.slack.com/',
      });
  });

  it('reports missing scopes', async () => {
    const fetchFn = fakeAuthTestFetch({
      scopes: ['channels:history', 'channels:read'], // incomplete
      body: { ok: true, team: 'Acme', team_id: 'T1', user_id: 'U1' },
    });
    const r = await validateSlackToken('xoxp-secret', fetchFn as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('missing-scope');
      expect(r.message).toContain('files:read');
    }
  });

  it('maps a Slack ok:false to auth-failed', async () => {
    const fetchFn = fakeAuthTestFetch({
      scopes: [...SLACK_USER_SCOPES],
      body: { ok: false, error: 'invalid_auth' },
    });
    const r = await validateSlackToken('xoxp-bad', fetchFn as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('auth-failed');
  });
});
