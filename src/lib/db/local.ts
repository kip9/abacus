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
  const db = drizzle(client, { schema });

  return {
    db,

    async query<T extends Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ rows: T[] }> {
      const result = await client.unsafe(
        strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), ''),
        values as postgres.ParameterOrJSON<never>[]
      );
      return { rows: result as unknown as T[] };
    },

    async close(): Promise<void> {
      await client.end();
    },
  };
}
