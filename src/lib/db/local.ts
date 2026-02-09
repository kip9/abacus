import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import type { DatabaseAdapter } from './types';

/**
 * Local Postgres adapter.
 * Uses the standard postgres.js driver for direct PostgreSQL connections.
 * Designed for local development and non-Vercel deployments.
 */
export function createLocalAdapter(connectionString: string): DatabaseAdapter {
  const client = postgres(connectionString);
  const rawDb = drizzle(client, { schema });

  // Wrap db to normalize execute() return value
  // postgres.js drizzle returns arrays, but we need { rows: T[] } to match Vercel
  const db = new Proxy(rawDb, {
    get(target, prop) {
      const value = Reflect.get(target, prop);

      if (prop === 'execute' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          // postgres.js returns array directly, wrap in { rows }
          if (Array.isArray(result)) {
            return { rows: result };
          }
          return result;
        };
      }

      return value;
    },
  }) as typeof rawDb;

  return {
    db,

    async sql<T extends Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ rows: T[]; rowCount?: number }> {
      const result = await client.unsafe(
        strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), ''),
        values as postgres.ParameterOrJSON<never>[]
      );
      return { rows: result as unknown as T[], rowCount: result.count };
    },

    async query<T extends Record<string, unknown>>(
      sqlString: string,
      values: unknown[]
    ): Promise<{ rows: T[]; rowCount?: number }> {
      const result = await client.unsafe(
        sqlString,
        values as postgres.ParameterOrJSON<never>[]
      );
      return { rows: result as unknown as T[], rowCount: result.count };
    },

    async close(): Promise<void> {
      await client.end();
    },
  };
}
