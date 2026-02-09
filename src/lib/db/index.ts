import { sql } from 'drizzle-orm';
import type { DatabaseAdapter, ProxiedDatabase } from './types';

export type { DatabaseAdapter, ProxiedDatabase } from './types';

/**
 * Detect which database driver to use.
 * - If USE_LOCAL_DB=1, use local postgres driver
 * - Otherwise, default to Vercel driver (production default)
 */
function useLocalDatabase(): boolean {
  return process.env.USE_LOCAL_DB === '1';
}

/**
 * Create a database adapter based on the current environment.
 */
export function createDatabaseAdapter(): DatabaseAdapter {
  if (useLocalDatabase()) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error('POSTGRES_URL environment variable is required for local database');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLocalAdapter } = require('./local');
    return createLocalAdapter(connectionString);
  } else {
    // Default: use Vercel/Neon driver
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createVercelAdapter } = require('./vercel');
    return createVercelAdapter();
  }
}

// Singleton adapter instance
let _adapter: DatabaseAdapter | null = null;

/**
 * Get the database adapter singleton.
 * Creates the adapter on first access (lazy initialization).
 */
export function getAdapter(): DatabaseAdapter {
  if (!_adapter) {
    _adapter = createDatabaseAdapter();
  }
  return _adapter;
}

/**
 * Lazy proxy for the database instance.
 * Defers adapter creation until first property access,
 * allowing environment variables to be loaded first.
 *
 * Also normalizes the `execute` method return value to always have a `.rows` property,
 * since postgres.js returns an array directly while Vercel returns { rows: T[] }.
 */
export const db: ProxiedDatabase = new Proxy({} as ProxiedDatabase, {
  get(_, prop) {
    const value = Reflect.get(getAdapter().db, prop);

    // Wrap execute method to normalize return value
    if (prop === 'execute' && typeof value === 'function') {
      return async (...args: unknown[]) => {
        const result = await value.apply(getAdapter().db, args);
        // If result is an array (postgres.js), wrap it in { rows: result }
        // If result already has .rows (Vercel), return as-is
        if (Array.isArray(result)) {
          return { rows: result };
        }
        return result;
      };
    }

    return value;
  },
});

/**
 * Execute raw SQL queries.
 * Lazily initializes the adapter on first call.
 */
export async function query<T extends Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<{ rows: T[] }> {
  return getAdapter().query<T>(strings, ...values);
}

// Re-export schema for convenience
export * from '../schema';

// Re-export sql for building queries
export { sql };
