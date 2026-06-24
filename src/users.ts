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
 * id → display-name directory. Preloaded once per connector-instance lifetime
 * (users.list is Tier 2 — never per delta poll); users.info fills cache misses.
 */
export class SlackUserDirectory {
  private names = new Map<string, string>();

  private preloadPromise?: Promise<void>;

  constructor(private readonly client: SlackClient) {}

  ensurePreloaded(): Promise<void> {
    this.preloadPromise ??= (async () => {
      for await (const page of this.client.pages<{
        ok: boolean;
        members?: SlackUserRecord[];
      }>('users.list', { limit: 200 })) {
        for (const u of page.members ?? []) this.names.set(u.id, bestName(u));
      }
    })();
    return this.preloadPromise;
  }

  resolve = (id?: string): string =>
    (id && this.names.get(id)) || id || 'unknown';

  async resolveOrFetch(id: string): Promise<string> {
    const hit = this.names.get(id);
    if (hit) return hit;
    try {
      const r = await this.client.call<{ ok: boolean; user?: SlackUserRecord }>(
        'users.info',
        { user: id },
      );
      const n = r.user ? bestName(r.user) : id;
      this.names.set(id, n);
      return n;
    } catch {
      return id;
    }
  }
}
