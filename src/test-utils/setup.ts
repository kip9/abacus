import { vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { server } from './msw-handlers';

// =============================================================================
// Test Environment Variables - Hardcoded defaults for test isolation
// =============================================================================

// Explicitly unset database URLs to ensure PGlite mock is used
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL;

// Set test defaults for common env vars (can be overridden with vi.stubEnv)
process.env.CRON_SECRET = 'test-cron-secret';
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.ANTHROPIC_ADMIN_KEY = 'test-anthropic-key';
process.env.CURSOR_ADMIN_KEY = 'test-cursor-key';

// =============================================================================
// Safety Check - Ensure tests never run against production database
// =============================================================================

const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (dbUrl) {
  try {
    const parsed = new URL(dbUrl);
    const safeHosts = ['localhost', '127.0.0.1', '::1'];
    const isDangerous =
      !safeHosts.includes(parsed.hostname) ||
      parsed.hostname.includes('neon.tech') ||
      parsed.hostname.includes('vercel') ||
      parsed.hostname.includes('supabase') ||
      parsed.hostname.includes('planetscale');

    if (isDangerous) {
      throw new Error(
        `\n\n` +
          `${'='.repeat(70)}\n` +
          `DANGER: Test database URL points to "${parsed.hostname}"\n` +
          `${'='.repeat(70)}\n\n` +
          `Tests must use localhost or leave POSTGRES_URL unset.\n` +
          `The test suite uses PGlite (in-memory) and does not need a real database.\n\n` +
          `If you see this error, you may have loaded .env.local by mistake.\n` +
          `${'='.repeat(70)}\n`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('DANGER')) throw e;
    // Invalid URL format - let it pass, will fail elsewhere if actually used
  }
}

// =============================================================================
// PGlite Database Setup - Mock @vercel/postgres with in-memory PGlite
// =============================================================================

// Store references for transaction management and db access
let pgliteClient: import('@electric-sql/pglite').PGlite | null = null;

// Shared reference for db mock (allows @/lib/db mock to access drizzle instance)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbRef: { current: any } = { current: null };

vi.mock('@vercel/postgres', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('../lib/schema');

  // Create in-memory PGlite instance
  pgliteClient = new PGlite();
  dbRef.current = drizzle(pgliteClient, { schema });

  // Push schema to in-memory database
  const { pushSchema } = await import('drizzle-kit/api');
  const { apply } = await pushSchema(schema, dbRef.current as never);
  await apply();

  // Create sql template function that forwards to PGlite
  // Returns object with .rows to match @vercel/postgres interface
  const sql = async function (strings: TemplateStringsArray, ...values: unknown[]) {
    let query = '';
    strings.forEach((str, i) => {
      query += str;
      if (i < values.length) {
        query += `$${i + 1}`;
      }
    });
    const result = await pgliteClient!.query(query, values as never[]);
    return { rows: result.rows };
  };

  sql.query = async (text: string, params?: unknown[]) => {
    const result = await pgliteClient!.query(text, params as never[]);
    return { rows: result.rows };
  };

  return { sql };
});

// Mock @/lib/db to use the PGlite-backed Drizzle instance
// This enables Drizzle query builder methods (db.insert, db.select, etc.) in tests
vi.mock('@/lib/db', async () => {
  const schema = await import('../lib/schema');

  // SQL template tag function for raw SQL queries (matches real sql interface)
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!pgliteClient) {
      throw new Error('Database not initialized - ensure @vercel/postgres mock runs first');
    }
    let queryStr = '';
    strings.forEach((str, i) => {
      queryStr += str;
      if (i < values.length) {
        queryStr += `$${i + 1}`;
      }
    });
    const result = await pgliteClient.query(queryStr, values as never[]);
    return { rows: result.rows, rowCount: result.affectedRows };
  };

  // Query function for parameterized queries
  const query = async (sqlString: string, values: unknown[]) => {
    if (!pgliteClient) {
      throw new Error('Database not initialized - ensure @vercel/postgres mock runs first');
    }
    const result = await pgliteClient.query(sqlString, values as never[]);
    return { rows: result.rows, rowCount: result.affectedRows };
  };

  return {
    // Proxy db to always use current drizzle instance (handles initialization timing)
    get db() {
      if (!dbRef.current) {
        throw new Error('Database not initialized - ensure @vercel/postgres mock runs first');
      }
      return dbRef.current;
    },
    sql,
    query,
    // Re-export schema
    ...schema,
  };
});

// Transaction management for test isolation
beforeEach(async () => {
  if (pgliteClient) {
    await pgliteClient.query('BEGIN');
  }
});

afterEach(async () => {
  if (pgliteClient) {
    await pgliteClient.query('ROLLBACK');
  }
});

afterAll(async () => {
  if (pgliteClient) {
    await pgliteClient.close();
  }
});

// =============================================================================
// Auth Mock - Global mock for @/lib/auth
// =============================================================================

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  requireSession: vi.fn().mockRejectedValue(new Error('Unauthorized')),
}));

// =============================================================================
// MSW Setup for External API Mocking
// =============================================================================

beforeAll(async () => {
  // Force @vercel/postgres mock to initialize by importing it
  // This ensures dbRef.current is set before any tests run
  await import('@vercel/postgres');
  server.listen({ onUnhandledRequest: 'warn' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
