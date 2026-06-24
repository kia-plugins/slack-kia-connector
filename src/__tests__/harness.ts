import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Minimal async DB wrapper over better-sqlite3, matching the Db surface the
 *  connector + its tests use. Schema is the app's schema.sql, exec'd once. */
export function openTestDb(): {
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
} {
  const conn = new Database(':memory:');
  conn.defaultSafeIntegers(true);
  const norm = (params: unknown[] = []) =>
    params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as never[];
  const db = {
    async all(sql: string, params: unknown[] = []) {
      return conn.prepare(sql).all(...norm(params)) as Record<string, unknown>[];
    },
    async run(sql: string, params: unknown[] = []) {
      conn.prepare(sql).run(...norm(params));
    },
    async exec(sql: string) {
      conn.exec(sql);
    },
    async close() {
      conn.close();
    },
  };
  conn.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}
