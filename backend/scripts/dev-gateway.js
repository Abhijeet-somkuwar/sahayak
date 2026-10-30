/**
 * Dev gateway: one origin for frontends. Routes /api/* → api (:3000) and /socket.io/* → realtime (:3001), with
 * WebSocket upgrade. In production a reverse proxy / load balancer does this (§4.1). Usage: npm run dev:gateway
 * Env: GATEWAY_PORT (8000), API_UPSTREAM (http://localhost:3000), REALTIME_UPSTREAM (http://localhost:3001)
 */
import 'dotenv/config';
import Fastify from 'fastify';
import proxy from '@fastify/http-proxy';

const port = Number(process.env['GATEWAY_PORT'] ?? 8000);
const api = process.env['API_UPSTREAM'] ?? 'http://localhost:3000';
const realtime = process.env['REALTIME_UPSTREAM'] ?? 'http://localhost:3001';

const app = Fastify({ logger: { level: 'info' } });
await app.register(proxy, { upstream: realtime, prefix: '/socket.io', rewritePrefix: '/socket.io', websocket: true });
await app.register(proxy, { upstream: api, prefix: '/api', rewritePrefix: '/api' });
app.get('/', async () => ({ gateway: 'sahayak-dev', api, realtime }));
await app.listen({ port, host: '0.0.0.0' });
console.log(`dev gateway on http://0.0.0.0:${port}  (/api → ${api}, /socket.io → ${realtime})`);
