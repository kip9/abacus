import { drizzle } from 'drizzle-orm/vercel-postgres';
import { sql } from '@vercel/postgres';
import * as schema from '../schema';
import type { DatabaseAdapter } from './types';

/**
 * Vercel Postgres adapter.
 * Uses @vercel/postgres which connects via WebSocket to Neon's serverless driver.
 * Designed for Vercel's edge/serverless environment.
 */
export function createVercelAdapter(): DatabaseAdapter {
  const db = drizzle(sql, { schema });

  return {
    db,

    async query<T extends Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ rows: T[] }> {
      const result = await sql.query(strings.join('$'), values);
      return { rows: result.rows as T[] };
    },

    async close(): Promise<void> {
      // No-op for serverless - connections are managed by Vercel
    },
  };
}
