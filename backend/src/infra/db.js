/**
 * Database access: primary (app role via PgBouncer), maintenance (owner, direct) and replica pools,
 * plus withScope() which sets the RLS request scope per transaction (§6.4 migration 0011, §13.3).
 */
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { env } from '../config/env.js';

import { logger } from './logger.js';
import { pgPoolWait } from './metrics.js';

const { Pool, types } = pg;

// date → keep as 'YYYY-MM-DD' string (never a local-midnight Date); int8 → number; numeric stays string.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));

function makePool(connectionString, max, application_name) {
  const pool = new Pool({ connectionString, max, application_name, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', (err) => logger.error({ err, pool: application_name }, 'pg pool error'));
  return pool;
}

export const primaryPool = makePool(env.DATABASE_URL, env.DB_POOL_MAX, `${env.SERVICE_NAME}-app`);
export const maintPool = makePool(env.DATABASE_URL_MAINT, 4, `${env.SERVICE_NAME}-maint`);
export const replicaPool = env.DATABASE_REPLICA_URL ? makePool(env.DATABASE_REPLICA_URL, 8, `${env.SERVICE_NAME}-replica`) : primaryPool;

export const db = new Kysely({ dialect: new PostgresDialect({ pool: primaryPool }) });
/** Owner connection: migrations, partition maintenance, retention, seeds. Not subject to RLS. */
export const maintDb = new Kysely({ dialect: new PostgresDialect({ pool: maintPool }) });
/** Read replica: analytics dashboards, public pages. */
export const replicaDb = new Kysely({ dialect: new PostgresDialect({ pool: replicaPool }) });

export const STATE_SCOPE = { kind: 'state' };
export function facilityScope(facilityIds) {
  return { kind: 'facility', facilityIds };
}

/**
 * Run `fn` in a transaction whose RLS scope is set with transaction-local settings (safe with PgBouncer).
 * An empty facility list means "no facilities" — queries return zero rows (fail closed).
 */
export async function withScope(scope, fn, database = db) {
  const started = process.hrtime.bigint();
  return database.transaction().execute(async (trx) => {
    pgPoolWait.observe(Number(process.hrtime.bigint() - started) / 1e9);
    const scopeValue = scope.kind === 'state' ? 'state' : 'facility';
    const ids = scope.kind === 'facility' ? scope.facilityIds.join(',') : '';
    await sql`SELECT set_config('app.scope', ${scopeValue}, true), set_config('app.facility_ids', ${ids}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Same as withScope but on the read replica. */
export function withReplicaScope(scope, fn) {
  return withScope(scope, fn, replicaDb);
}

/** Runs as the owner role (no RLS). Only for maintenance jobs and seeds. */
export function withMaint(fn) {
  return maintDb.transaction().execute(fn);
}

export async function checkDatabase() {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch (err) {
    logger.warn({ err }, 'database readiness check failed');
    return false;
  }
}

export async function closeDatabase() {
  await Promise.allSettled([db.destroy(), maintDb.destroy(), replicaPool !== primaryPool ? replicaDb.destroy() : Promise.resolve()]);
}
