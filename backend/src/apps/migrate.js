/** One-shot migration runner used by the `migrate` compose service (dbmate-compatible). */
process.env['SAHAYAK_ROLE'] = 'migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { migrateUp } from '../infra/migrate.js';
import { env } from '../config/env.js';

const client = new pg.Client({ connectionString: env.DATABASE_URL_MAINT });
await client.connect();
const dir = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const applied = await migrateUp(client, dir, (m) => console.log(m));
console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema up to date');
await client.end();
