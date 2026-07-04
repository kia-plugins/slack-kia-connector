import type { SlackClient } from './client';

interface SlackUserRecord {
  id: string;
  name?: string;
  profile?: { display_name?: string; real_name?: string };
}

function bestName(u: SlackUserRecord): string {
  return u.profile?.display_name || u.profile?.real_name || u.name || u.id;
}

/**
 * id → display-name directory. Preloaded once per account per source lifetime
 * (users.list is Tier 2 — never per delta poll); the source caches one
 * directory per account across pull cycles, so only the first pull pays the
 * users.list walk. A user who joins later resolves as their raw id until the
 * extension host restarts — v1 accepted the same trade.
 */
export class SlackUserDirectory {
  private names = new Map<string, string>();

  private preloadPromise?: Promise<void>;

  ensurePreloaded(client: SlackClient): Promise<void> {
    this.preloadPromise ??= (async () => {
      for await (const page of client.pages<{
        ok: boolean;
        members?: SlackUserRecord[];
      }>('users.list', { limit: 200 })) {
        for (const u of page.members ?? []) this.names.set(u.id, bestName(u));
      }
    })().catch((e) => {
      // A failed preload must not wedge every future pull on the same
      // rejected promise — reset so the next pull retries.
      this.preloadPromise = undefined;
      throw e;
    });
    return this.preloadPromise;
  }

  resolve = (id?: string): string =>
    (id && this.names.get(id)) || id || 'unknown';
}
