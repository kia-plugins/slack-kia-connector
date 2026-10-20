/**
 * Live-poll scheduling. A workspace can hold hundreds of member conversations
 * (one real account: 453, of which 379 had no message in over a year), so a
 * plain stalest-first rotation spends most of each poll's budget re-reading
 * dead group DMs while a live DM waits hours for its turn. Instead each
 * conversation and thread gets a minimum re-poll interval from how recently
 * it saw activity, and only due ones compete for the budget.
 *
 * Tiers are derived per poll from timestamps already in the cursor — nothing
 * new is persisted for them, so a conversation that wakes up moves to the
 * active tier on the poll after the one that saw its new message.
 */
import type { ActiveThread, CursorConversation } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type Tier = 0 | 1 | 2;

/** Conversation tiers by age of the newest message: active < 7 days, warm
 *  < 1 year, cold beyond (or never had a message). */
export const ACTIVE_CONVERSATION_MS = 7 * DAY;
export const WARM_CONVERSATION_MS = 365 * DAY;
/** Minimum re-poll interval per conversation tier — active every poll. */
export const CONVERSATION_INTERVAL_MS: Record<Tier, number> = {
  0: 0,
  1: HOUR,
  2: 6 * HOUR,
};

/** Thread tiers by age of the newest known reply: hot < 1 day, warm < 7
 *  days, cool beyond (until the active-thread window expires it). */
export const HOT_THREAD_MS = DAY;
export const WARM_THREAD_MS = 7 * DAY;
export const THREAD_INTERVAL_MS: Record<Tier, number> = {
  0: 0,
  1: HOUR,
  2: 6 * HOUR,
};

/** Polls run every 15 minutes but stamps land a minute or two into a poll;
 *  without this grace an hourly conversation would slip to 75 minutes. */
export const DUE_GRACE_MS = 5 * MIN;

const ageMs = (ts: string, nowMs: number): number => {
  const t = Number(ts);
  return t > 0 ? nowMs - t * 1000 : Number.POSITIVE_INFINITY;
};

export function conversationTier(latestTs: string, nowMs: number): Tier {
  const age = ageMs(latestTs, nowMs);
  if (age < ACTIVE_CONVERSATION_MS) return 0;
  if (age < WARM_CONVERSATION_MS) return 1;
  return 2;
}

/** The thread's last known activity: its newest reply, or its own ts for a
 *  root discovered but not yet fetched (last_reply_ts '0'). */
export const threadActivityTs = (t: ActiveThread): string =>
  t.last_reply_ts === '0' ? t.thread_ts : t.last_reply_ts;

export function threadTier(activityTs: string, nowMs: number): Tier {
  const age = ageMs(activityTs, nowMs);
  if (age < HOT_THREAD_MS) return 0;
  if (age < WARM_THREAD_MS) return 1;
  return 2;
}

export function isDue(
  lastIso: string | undefined,
  intervalMs: number,
  nowMs: number,
): boolean {
  if (!lastIso || intervalMs <= 0) return true;
  return nowMs - Date.parse(lastIso) >= intervalMs - DUE_GRACE_MS;
}

/** Stalest first; never-polled ('' sorts before any ISO stamp) leads. */
const byStamp = (a: string | undefined, b: string | undefined) =>
  (a ?? '').localeCompare(b ?? '');

export interface PlannedConversation {
  id: string;
  conv: CursorConversation;
  tier: Tier;
}

/** Due conversations in poll order: active tier first, stalest first within
 *  a tier. */
export function orderConversations(
  conversations: Record<string, CursorConversation>,
  nowMs: number,
): PlannedConversation[] {
  const out: PlannedConversation[] = [];
  for (const [id, conv] of Object.entries(conversations)) {
    const tier = conversationTier(conv.latest_ts, nowMs);
    if (isDue(conv.last_polled, CONVERSATION_INTERVAL_MS[tier], nowMs))
      out.push({ id, conv, tier });
  }
  return out.sort(
    (a, b) => a.tier - b.tier || byStamp(a.conv.last_polled, b.conv.last_polled),
  );
}

/** Due threads in probe order: hottest tier first, stalest probe first
 *  within a tier. Returns the cursor's own objects (the probe mutates them). */
export function orderThreads(
  threads: ActiveThread[],
  nowMs: number,
): ActiveThread[] {
  return threads
    .map((t) => ({ t, tier: threadTier(threadActivityTs(t), nowMs) }))
    .filter(({ t, tier }) => isDue(t.last_probed, THREAD_INTERVAL_MS[tier], nowMs))
    .sort((a, b) => a.tier - b.tier || byStamp(a.t.last_probed, b.t.last_probed))
    .map(({ t }) => t);
}
