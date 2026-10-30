/** realtime role (§4.2): Socket.IO for doctor dashboards, TV displays and patient status pages. */
process.env['SAHAYAK_ROLE'] = 'realtime';
import { startTelemetry } from '../infra/otel.js';
await startTelemetry('realtime');
const { startRealtime } = await import('../modules/realtime/server.js');
const { registerShutdown } = await import('../server.js');
const { closeRedis } = await import('../infra/redis.js');
const { closeDatabase } = await import('../infra/db.js');
const rt = await startRealtime();
registerShutdown(async () => {
  await rt.close();
  await closeRedis();
  await closeDatabase();
});
