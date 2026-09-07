import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  readonly db: Db;
  readonly sql: postgres.Sql;
  /** Cheap liveness probe for `GET /api/health`. Resolves or throws. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(env: Env): Database {
  const sql = postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    // Prepared statements are incompatible with PgBouncer in transaction mode,
    // which is how Supabase's pooler runs. Disabling them costs very little and
    // removes an entire class of environment-dependent failure.
    prepare: false,
    onnotice: () => {},
  });

  return {
    db: drizzle(sql, { schema }),
    sql,

    async ping(timeoutMs = 2_000): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('database ping timed out')), timeoutMs);
        timer.unref();
      });
      try {
        await Promise.race([sql`select 1`, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
