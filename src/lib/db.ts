/**
 * Database module - re-exports from db/ for backward compatibility.
 *
 * The database adapter automatically selects the appropriate driver:
 * - Vercel environment: Uses @vercel/postgres (WebSocket/Neon)
 * - Local environment: Uses postgres.js (standard PostgreSQL)
 */

// Re-export everything from the new db module
export { db, sql, query, getAdapter, createDatabaseAdapter } from './db/index';
export type { DatabaseAdapter } from './db/index';

// Re-export schema for convenience
export * from './schema';
