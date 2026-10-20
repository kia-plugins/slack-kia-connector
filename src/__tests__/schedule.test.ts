import {
  conversationTier,
  isDue,
  orderConversations,
  orderThreads,
  threadTier,
} from '../schedule';

const NOW = Date.parse('2024-06-01T12:00:00.000Z');
const tsAgo = (ms: number) => String((NOW - ms) / 1000);
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('conversationTier', () => {
  it('is active under 7 days, warm under a year, cold beyond or when empty', () => {
    expect(conversationTier(tsAgo(2 * HOUR), NOW)).toBe(0);
    expect(conversationTier(tsAgo(6.9 * DAY), NOW)).toBe(0);
    expect(conversationTier(tsAgo(8 * DAY), NOW)).toBe(1);
    expect(conversationTier(tsAgo(300 * DAY), NOW)).toBe(1);
    expect(conversationTier(tsAgo(400 * DAY), NOW)).toBe(2);
    expect(conversationTier('0', NOW)).toBe(2);
  });
});

describe('threadTier', () => {
  it('is hot under a day, warm under 7 days, cool beyond', () => {
    expect(threadTier(tsAgo(3 * HOUR), NOW)).toBe(0);
    expect(threadTier(tsAgo(3 * DAY), NOW)).toBe(1);
    expect(threadTier(tsAgo(10 * DAY), NOW)).toBe(2);
  });
});

describe('isDue', () => {
  it('is due when never polled or when the interval (minus a 5-minute grace) has passed', () => {
    expect(isDue(undefined, HOUR, NOW)).toBe(true);
    expect(isDue(isoAgo(1), 0, NOW)).toBe(true);
    expect(isDue(isoAgo(30 * MIN), HOUR, NOW)).toBe(false);
    // a poll stamped a minute or two late must not slip a whole cadence
    expect(isDue(isoAgo(58 * MIN), HOUR, NOW)).toBe(true);
  });
});

describe('orderConversations', () => {
  it('keeps only due conversations, active tier first, stalest first within a tier', () => {
    const order = orderConversations(
      {
        warmDue: { latest_ts: tsAgo(30 * DAY), name: 'w', kind: 'im', last_polled: isoAgo(2 * HOUR) },
        warmNotDue: { latest_ts: tsAgo(30 * DAY), name: 'w2', kind: 'im', last_polled: isoAgo(20 * MIN) },
        coldNotDue: { latest_ts: '0', name: 'c', kind: 'mpim', last_polled: isoAgo(3 * HOUR) },
        coldDue: { latest_ts: '0', name: 'c2', kind: 'mpim', last_polled: isoAgo(25 * HOUR) },
        activeRecent: { latest_ts: tsAgo(HOUR), name: 'a', kind: 'im', last_polled: isoAgo(15 * MIN) },
        activeStale: { latest_ts: tsAgo(2 * DAY), name: 'b', kind: 'im', last_polled: isoAgo(4 * HOUR) },
      },
      NOW,
    );
    expect(order.map((o) => o.id)).toEqual(['activeStale', 'activeRecent', 'warmDue', 'coldDue']);
    expect(order.map((o) => o.tier)).toEqual([0, 0, 1, 2]);
  });
});

describe('orderThreads', () => {
  it('keeps only due threads, newest activity tier first; a new root (last_reply_ts 0) tiers by its own ts', () => {
    const order = orderThreads(
      [
        { channel: 'C', thread_ts: tsAgo(10 * DAY), last_reply_ts: tsAgo(10 * DAY), last_probed: isoAgo(7 * HOUR) },
        { channel: 'C', thread_ts: tsAgo(10 * DAY), last_reply_ts: tsAgo(9 * DAY), last_probed: isoAgo(HOUR) },
        { channel: 'C', thread_ts: tsAgo(2 * HOUR), last_reply_ts: '0' },
        { channel: 'C', thread_ts: tsAgo(3 * DAY), last_reply_ts: tsAgo(2 * DAY), last_probed: isoAgo(2 * HOUR) },
      ],
      NOW,
    );
    expect(order.map((t) => t.thread_ts)).toEqual([tsAgo(2 * HOUR), tsAgo(3 * DAY), tsAgo(10 * DAY)]);
    expect(order[2].last_probed).toBe(isoAgo(7 * HOUR));
  });
});
