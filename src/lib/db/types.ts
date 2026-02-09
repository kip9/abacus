import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { VercelPgDatabase } from 'drizzle-orm/vercel-postgres';
import type { SQL } from 'drizzle-orm';
import type * as schema from '../schema';

/**
 * Database adapter interface.
 * Abstracts the underlying database driver (Vercel Postgres vs standard postgres).
 */
export interface DatabaseAdapter {
  /** Drizzle ORM instance for type-safe queries */
  db: PostgresJsDatabase<typeof schema> | VercelPgDatabase<typeof schema>;

  /**
   * Execute a raw SQL query using template literals.
   * @example
   * const result = await adapter.query`SELECT * FROM users WHERE id = ${userId}`;
   */
  query<T extends Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<{ rows: T[] }>;

  /**
   * Close the database connection (no-op for serverless drivers).
   */
  close(): Promise<void>;
}

/**
 * Normalized execute result type.
 * Our proxy ensures execute() always returns this format regardless of driver.
 */
export interface ExecuteResult<T> {
  rows: T[];
}

/**
 * Proxied database type with normalized execute() method.
 * This type reflects the runtime behavior of our db proxy which normalizes
 * the execute() return value to always have a .rows property.
 */
export type ProxiedDatabase = Omit<
  PostgresJsDatabase<typeof schema>,
  'execute' | '_'
> & {
  execute<T extends Record<string, unknown>>(
    query: SQL<unknown>
  ): Promise<ExecuteResult<T>>;
  _: PostgresJsDatabase<typeof schema>['_'];
}
