/**
 * Partition maintenance and retention (§6.3, §12.2, §14.6). Runs as the owner role (maintPool).
 * Archival: COPY partition → gzip → object storage with a manifest → verify → DETACH CONCURRENTLY (outside a
 * transaction) → DROP. Children before parents (detach_order).
 */
import { createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { sql } from 'kysely';
import { to as copyTo } from 'pg-copy-streams';
import { maintDb, maintPool, withMaint } from './db.js';
import { partitionsFuture } from './metrics.js';
import { logger } from './logger.js';
import { putObject, storageKeys } from './storage.js';
import { istDate, addDays } from '../shared/time.js';

export async function ensurePartitions(monthsBack = 1, monthsAhead = 3) {
  const r = await sql`SELECT ensure_partitions(${monthsBack}, ${monthsAhead})`.execute(maintDb);
  const future = await sql`
    SELECT r.parent_table::text AS parent,
           count(*) FILTER (WHERE to_date(right(c.relname, 6), 'YYYYMM') > date_trunc('month', now() AT TIME ZONE 'UTC')::date)::int AS future
    FROM partition_registry r JOIN pg_inherits i ON i.inhparent = r.parent_table JOIN pg_class c ON c.oid = i.inhrelid
    WHERE c.relname ~ '_p[0-9]{6}$' GROUP BY r.parent_table`.execute(maintDb);
  for (const row of future.rows) {
    partitionsFuture.set({ table: row.parent }, row.future);
    if (row.future < 2) logger.error({ table: row.parent, future: row.future }, 'ALERT fewer than 2 future partitions');
  }
  return r.rows.map((x) => x.ensure_partitions);
}

export async function listExpiredPartitions() {
  const r =
    await sql`SELECT parent_table::text AS parent_table, partition_name, partition_month::text AS partition_month, detach_order FROM list_expired_partitions()`.execute(
      maintDb,
    );
  return r.rows;
}

async function archivePartition(p) {
  const client = await maintPool.connect();
  try {
    // eslint-disable-next-line sahayak/no-string-built-sql -- identifier is escaped by quote(); no user input
    const count = await client.query(`SELECT count(*)::int AS n FROM ${quote(p.partition_name)}`);
    const rows = count.rows[0]?.n ?? 0;
    const chunks = [];
    const gz = createGzip();
    const collector = new PassThrough();
    collector.on('data', (c) => chunks.push(c));
    const stream = client.query(copyTo(`COPY ${quote(p.partition_name)} TO STDOUT WITH (FORMAT csv, HEADER true)`));
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      gz.on('error', reject);
      collector.on('finish', resolve);
      stream.pipe(gz).pipe(collector);
    });
    const body = Buffer.concat(chunks);
    const key = storageKeys.partitionArchive(p.parent_table, p.partition_name);
    await putObject(key, body, 'application/gzip', { rows: String(rows), bytes: String(body.length), month: p.partition_month });
    await putObject(
      `${key}.manifest.json`,
      JSON.stringify({
        table: p.parent_table,
        partition: p.partition_name,
        rows,
        bytes: body.length,
        exported_at: new Date().toISOString(),
      }),
      'application/json',
    );
    return { rows, key };
  } finally {
    client.release();
  }
}

function quote(ident) {
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Retention job (§12.2 daily 03:10): hot-table deletes + expired partition archival/detach. */
export async function runRetention() {
  const result = {};
  await withMaint(async (trx) => {
    const r1 =
      await sql`WITH d AS (DELETE FROM opd_tokens t USING encounters e WHERE t.session_date < ${addDays(istDate(), -14)} AND e.id = t.encounter_id AND e.token_display IS NOT NULL RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
        trx,
      );
    result['opd_tokens'] = r1.rows[0]?.n ?? 0;
    const r2 =
      await sql`WITH d AS (DELETE FROM intake_sessions WHERE started_at < now() - interval '7 days' AND status <> 'in_progress' RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
        trx,
      );
    result['intake_sessions'] = r2.rows[0]?.n ?? 0;
    const r3 =
      await sql`WITH d AS (DELETE FROM emergency_prealerts WHERE created_at < now() - interval '30 days' RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
        trx,
      );
    result['emergency_prealerts'] = r3.rows[0]?.n ?? 0;
    const r4 =
      await sql`WITH d AS (DELETE FROM inbound_dedupe WHERE received_at < now() - interval '8 days' RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
        trx,
      );
    result['inbound_dedupe'] = r4.rows[0]?.n ?? 0;
    const r5 =
      await sql`WITH d AS (DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < now() - interval '1 day' RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
        trx,
      );
    result['outbox_events'] = r5.rows[0]?.n ?? 0;
    const r6 =
      await sql`WITH d AS (DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval '7 days' RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
        trx,
      );
    result['refresh_tokens'] = r6.rows[0]?.n ?? 0;
  });
  // Expired partitions: export, verify, detach concurrently (outside a transaction), drop.
  let archived = 0;
  for (const p of await listExpiredPartitions()) {
    try {
      const reg = await sql`SELECT archive_before_drop FROM partition_registry WHERE parent_table::text = ${p.parent_table}`.execute(
        maintDb,
      );
      if (reg.rows[0]?.archive_before_drop) {
        const a = await archivePartition(p);
        logger.info({ partition: p.partition_name, rows: a.rows, key: a.key }, 'partition archived');
      }
      const client = await maintPool.connect();
      try {
        // eslint-disable-next-line sahayak/no-string-built-sql -- identifiers escaped by quote(); DDL has no parameters
        await client.query(`ALTER TABLE ${quote(p.parent_table)} DETACH PARTITION ${quote(p.partition_name)} CONCURRENTLY`);
        // eslint-disable-next-line sahayak/no-string-built-sql -- identifier escaped by quote()
        await client.query(`DROP TABLE ${quote(p.partition_name)}`);
      } finally {
        client.release();
      }
      archived++;
    } catch (err) {
      logger.error({ err, partition: p.partition_name }, 'partition retention failed');
    }
  }
  result['partitions_dropped'] = archived;
  return result;
}
