/** webhook role (§4.2): receives WhatsApp webhooks, verifies signatures, dedupes, enqueues, returns 200 fast. */
process.env['SAHAYAK_ROLE'] = 'webhook';
import { startTelemetry } from '../infra/otel.js';
await startTelemetry('webhook');
const { buildServer, registerShutdown, env } = await import('../server.js');
const { whatsappWebhookRoutes } = await import('../modules/whatsapp/routes.js');
const { closeRedis } = await import('../infra/redis.js');
const { closeQueues } = await import('../infra/queues.js');

const app = await buildServer({ role: 'webhook', withAuth: false, withDocs: false });
await app.register(whatsappWebhookRoutes);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
registerShutdown(async () => {
  await app.close();
  await closeQueues();
  await closeRedis();
});
