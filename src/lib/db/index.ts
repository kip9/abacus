import type { DatabaseAdapter, ProxiedDatabase, QueryResultRow } from './types';

export type { DatabaseAdapter, ProxiedDatabase, QueryResultRow } from './types';

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
 */
export const db: ProxiedDatabase = new Proxy({} as ProxiedDatabase, {
  get(_, prop) {
    return Reflect.get(getAdapter().db, prop);
  },
});

/**
 * Execute raw SQL queries using template literals.
 * Lazily initializes the adapter on first call.
 *
 * Matches the API of @vercel/postgres sql template tag.
 *
 * @typeParam O - The expected row type. Defaults to any if not specified.
 * @example
 * // Without type parameter (returns any rows, like Vercel)
 * const result = await sql`SELECT * FROM users`;
 * console.log(result.rows[0].email);
 *
 * // With type parameter (returns typed rows)
 * const result = await sql<{ email: string }>`SELECT email FROM users`;
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sql<O extends QueryResultRow = any>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<{ rows: O[]; rowCount?: number }> {
  const result = await getAdapter().sql(strings, ...values);
  return { rows: result.rows as O[], rowCount: result.rowCount };
}

/**
 * Execute a parameterized SQL query with a raw SQL string and values array.
 * Use this when building dynamic SQL queries programmatically.
 *
 * @typeParam O - The expected row type. Defaults to any if not specified.
 * @example
 * // Without type parameter
 * const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
 *
 * // With type parameter
 * const result = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<O extends QueryResultRow = any>(
  sqlString: string,
  values: unknown[]
): Promise<{ rows: O[]; rowCount?: number }> {
  const result = await getAdapter().query(sqlString, values);
  return { rows: result.rows as O[], rowCount: result.rowCount };
}

// Re-export schema for convenience
export * from '../schema';
