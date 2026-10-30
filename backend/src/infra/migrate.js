/**
 * dbmate-compatible migration runner (same file format and schema_migrations table), used by tests,
 * the `migrate` compose service and `npm run db:migrate:node`. Production deploys may use the dbmate binary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      const upIdx = text.search(/^-- migrate:up.*$/m);
      const downIdx = text.search(/^-- migrate:down.*$/m);
      if (upIdx < 0) throw new Error(`${file}: missing -- migrate:up`);
      const upHeader = text.slice(upIdx).split('\n')[0] ?? '';
      const downHeader = downIdx >= 0 ? (text.slice(downIdx).split('\n')[0] ?? '') : '';
      const upBody = text.slice(upIdx + upHeader.length, downIdx >= 0 ? downIdx : undefined);
      const downBody = downIdx >= 0 ? text.slice(downIdx + downHeader.length) : '';
      const version = file.split('_')[0];
      return {
        version,
        name: file,
        up: upBody,
        down: downBody,
        upTransaction: !/transaction:\s*false/.test(upHeader),
        downTransaction: !/transaction:\s*false/.test(downHeader),
      };
    });
}

async function ensureTable(client) {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(128) PRIMARY KEY)');
}

export async function appliedVersions(client) {
  await ensureTable(client);
  const r = await client.query('SELECT version FROM schema_migrations');
  return new Set(r.rows.map((x) => x.version));
}

async function runSql(client, body, transactional, after) {
  if (transactional) {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query(body);
      await client.query(after);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } else {
    await client.query(body);
    await client.query(after);
  }
}

export async function migrateUp(client, dir, log = () => {}) {
  const applied = await appliedVersions(client);
  const done = [];
  for (const m of loadMigrations(dir)) {
    if (applied.has(m.version)) continue;
    log(`applying ${m.name}`);
    // eslint-disable-next-line sahayak/no-string-built-sql -- version is the numeric prefix of a migration file name
    await runSql(client, m.up, m.upTransaction, `INSERT INTO schema_migrations (version) VALUES ('${m.version}')`);
    done.push(m.name);
  }
  return done;
}

export async function migrateDown(client, dir, steps = 1, log = () => {}) {
  const applied = await appliedVersions(client);
  const all = loadMigrations(dir)
    .filter((m) => applied.has(m.version))
    .reverse();
  const done = [];
  for (const m of all.slice(0, steps)) {
    log(`rolling back ${m.name}`);
    // eslint-disable-next-line sahayak/no-string-built-sql -- version is the numeric prefix of a migration file name
    await runSql(client, m.down, m.downTransaction, `DELETE FROM schema_migrations WHERE version = '${m.version}'`);
    done.push(m.name);
  }
  return done;
}
