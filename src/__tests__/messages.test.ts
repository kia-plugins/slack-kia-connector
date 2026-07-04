/**
 * Pure-helper suite (v2 home of v1's thread-builder.test.ts assertions that
 * survived the port — archiveUrl, day keying, indexability). The suite runs
 * with TZ=UTC (see jest.config.js) so local-day math is deterministic.
 */
import {
  archiveUrl,
  dayKey,
  indexable,
  localDayStartTs,
  toRendered,
  tsToDate,
} from '../messages';

describe('archiveUrl', () => {
  it('builds a permalink from team url + channel + ts', () => {
    expect(archiveUrl('https://acme.slack.com/', 'C1', '1700000000.000100')).toBe(
      'https://acme.slack.com/archives/C1/p1700000000000100',
    );
  });

  it('tolerates a team url without the trailing slash', () => {
    expect(archiveUrl('https://acme.slack.com', 'C1', '1.2')).toBe(
      'https://acme.slack.com/archives/C1/p12',
    );
  });
});

describe('tsToDate / dayKey / localDayStartTs', () => {
  it('parses Slack ts into a Date via parseFloat*1000', () => {
    expect(tsToDate('1704240000.000100').toISOString()).toBe(
      '2024-01-03T00:00:00.000Z',
    );
  });

  it('dayKey groups by the local (=UTC here) wall-clock day', () => {
    expect(dayKey(new Date(1704240000000))).toBe('2024-01-03');
    expect(dayKey(new Date(1704239999000))).toBe('2024-01-02');
  });

  it('localDayStartTs floors a ts to its local day start (and never below 0)', () => {
    expect(localDayStartTs('1704154200.000100')).toBe('1704153600');
    expect(localDayStartTs('0')).toBe('0');
  });
});

describe('indexable', () => {
  it('drops join/leave/deleted subtypes and empty messages', () => {
    expect(indexable({ ts: '1', subtype: 'channel_join', text: 'joined' })).toBe(false);
    expect(indexable({ ts: '1', subtype: 'message_deleted' })).toBe(false);
    expect(indexable({ ts: '1', text: '   ' })).toBe(false);
    expect(indexable({ ts: '1' })).toBe(false);
  });

  it('keeps messages with text or files', () => {
    expect(indexable({ ts: '1', text: 'hi' })).toBe(true);
    expect(indexable({ ts: '1', files: [{ id: 'F1' }] })).toBe(true);
  });
});

describe('toRendered', () => {
  const resolve = (id?: string) => (id === 'U1' ? 'Alice' : (id ?? 'unknown'));

  it('resolves the author, renders mrkdwn, and collects live file ids', () => {
    const r = toRendered(
      {
        ts: '1704240000.000100',
        user: 'U1',
        text: 'this *is* bold &amp; more',
        files: [
          { id: 'F1', url_private: 'https://files.slack.com/F1' },
          { id: 'F2', url_private: 'https://files.slack.com/F2', mode: 'tombstone' },
          { id: 'F3' }, // no url_private
        ],
      },
      resolve,
    );
    expect(r).toEqual({
      ts: '1704240000.000100',
      userName: 'Alice',
      text: 'this **is** bold & more',
      fileIds: ['F1'],
    });
  });

  it('falls back to bot_id for authorless messages', () => {
    const r = toRendered({ ts: '1', bot_id: 'B7', text: 'beep' }, resolve);
    expect(r.userName).toBe('B7');
  });
});
