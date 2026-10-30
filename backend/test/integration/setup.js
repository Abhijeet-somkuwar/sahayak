/**
 * Integration test harness (§16): a throwaway PostgreSQL 18 + pgvector container and a Redis 8 container via
 * Testcontainers, migrations applied with the dbmate-compatible runner. Set TEST_DATABASE_URL / TEST_REDIS_URL
 * to reuse the docker-compose services instead (faster locally).
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GenericContainer } from 'testcontainers';
import { migrateUp, migrateDown } from '../../src/infra/migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const ROLES_SQL = fileURLToPath(new URL('../../db/init/01-roles.sql', import.meta.url));

export async function startInfra() {
  const containers = [];
  let maintUrl = process.env['TEST_DATABASE_URL'];
  let redisUrl = process.env['TEST_REDIS_URL'];
  if (!maintUrl) {
    const pgc = await new GenericContainer('pgvector/pgvector:pg18')
      .withEnvironment({ POSTGRES_DB: 'sahayak', POSTGRES_USER: 'sahayak_maint', POSTGRES_PASSWORD: 'dev' })
      .withExposedPorts(5432)
      .withBindMounts([{ source: ROLES_SQL, target: '/docker-entrypoint-initdb.d/01-roles.sql', mode: 'ro' }])
      .withCommand(['postgres', '-c', 'log_min_duration_statement=-1'])
      .start();
    containers.push(pgc);
    maintUrl = `postgres://sahayak_maint:dev@${pgc.getHost()}:${pgc.getMappedPort(5432)}/sahayak`;
    await waitForPg(maintUrl);
  }
  if (!redisUrl) {
    const rc = await new GenericContainer('redis:8').withExposedPorts(6379).start();
    containers.push(rc);
    redisUrl = `redis://${rc.getHost()}:${rc.getMappedPort(6379)}`;
  }
  const client = new pg.Client({ connectionString: maintUrl });
  await client.connect();
  await migrateDown(client, MIGRATIONS, 100);
  await migrateUp(client, MIGRATIONS);
  await client.end();
  const appUrl = maintUrl.replace('sahayak_maint:dev', 'sahayak_api:dev');
  return {
    maintUrl,
    appUrl,
    redisUrl,
    stop: async () => {
      for (const c of containers) await c.stop().catch(() => {});
    },
  };
}

async function waitForPg(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query('select 1');
      await c.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('postgres did not become ready');
}

/** Sets process.env so that src/config/env.ts validates against the test infra. Must run before importing src/*. */
export function applyEnv(infra) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: infra.appUrl,
    DATABASE_URL_MAINT: infra.maintUrl,
    DATABASE_REPLICA_URL: infra.maintUrl,
    REDIS_CORE_URL: infra.redisUrl,
    REDIS_CACHE_URL: infra.redisUrl,
    DEV_MASTER_KEY: Buffer.from('sahayak-dev-master-key-32-bytes!').toString('base64'),
    BLIND_INDEX_KEY: Buffer.from('sahayak-dev-blind-index-32bytes!').toString('base64'),
    JWT_PRIVATE_KEY: process.env['JWT_PRIVATE_KEY'] ?? TEST_JWT.priv,
    JWT_PUBLIC_KEY: process.env['JWT_PUBLIC_KEY'] ?? TEST_JWT.pub,
    WA_APP_SECRET: 'test-secret',
    WA_VERIFY_TOKEN: 'verify',
    EMBEDDINGS_PROVIDER: 'mock',
    ANTHROPIC_API_KEY: '',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'x',
  });
}

import { generateKeyPairSync } from 'node:crypto';
const kp = generateKeyPairSync('ed25519');
export const TEST_JWT = {
  priv: Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64'),
  pub: Buffer.from(kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString('base64'),
};
