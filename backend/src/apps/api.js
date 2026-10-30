/** api role (§4.2): REST API for patients, staff, admins and devices. */
process.env['SAHAYAK_ROLE'] = 'api';
import { startTelemetry } from '../infra/otel.js';
await startTelemetry('api');
const { buildServer, registerShutdown, env } = await import('../server.js');
const { closeDatabase } = await import('../infra/db.js');
const { closeRedis } = await import('../infra/redis.js');
const { closeQueues } = await import('../infra/queues.js');
const { ensureBucket } = await import('../infra/storage.js');
const { registerApiRoutes } = await import('./routes.js');

const app = await buildServer({ role: 'api' });
await registerApiRoutes(app);
await ensureBucket();
await app.listen({ port: env.PORT, host: '0.0.0.0' });
registerShutdown(async () => {
  await app.close();
  await closeQueues();
  await closeRedis();
  await closeDatabase();
});
