/** Programmatic dbmate-compatible migrations: `tsx scripts/migrate.ts up|down [steps]`. */
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { migrateDown, migrateUp } from '../src/infra/migrate.js';

const url = process.env['DATABASE_URL_MAINT'];
if (!url) {
  console.error('DATABASE_URL_MAINT is required');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
const dir = fileURLToPath(new URL('../db/migrations', import.meta.url));
const [cmd = 'up', stepsArg] = process.argv.slice(2);
const done =
  cmd === 'down' ? await migrateDown(client, dir, Number(stepsArg ?? 1), console.log) : await migrateUp(client, dir, console.log);
console.log(`${cmd}: ${done.length} migration(s)`);
await client.end();
