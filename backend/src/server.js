/**
 * Fastify server builder shared by the api and webhook roles. Registers: request ids, error → problem+json,
 * auth principal + RBAC, audit onSend hook, idempotency, rate limits, OpenAPI, health and metrics.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { env, isProd } from './config/env.js';
import { logger } from './infra/logger.js';
import { checkDatabase } from './infra/db.js';
import { checkRedisCore, redisCore } from './infra/redis.js';
import { httpRequestDuration, renderMetrics } from './infra/metrics.js';
import { AppError, toProblem } from './shared/errors.js';
import { registerAuthHooks } from './shared/auth.js';
import { registerAuditHook } from './shared/audit.js';
import { registerIdempotencyHooks } from './shared/idempotency.js';
import { newId } from './shared/ids.js';
import './shared/http.js';

export async function buildServer(opts) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 128 ? req.headers['x-request-id'] : newId(),
    requestIdHeader: false,
    bodyLimit: 256 * 1024, // JSON bodies ≤ 256 KB (§13.4)
    trustProxy: true,
    disableRequestLogging: true,
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest('requestId', '');
  app.addHook('onRequest', async (req, reply) => {
    req.requestId = req.id;
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    httpRequestDuration.observe({ route, method: req.method, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (!['/api/v1/healthz', '/api/v1/readyz', '/api/v1/metrics'].includes(route)) {
      req.log.info(
        {
          request_id: req.id,
          route,
          method: req.method,
          status: reply.statusCode,
          latency_ms: Math.round(reply.elapsedTime),
          actor_kind: req.principal?.kind,
        },
        'request',
      );
    }
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  // Dev: reflect any origin (LAN frontends) with credentials; prod: explicit allow-list from CORS_ORIGINS.
  const corsOrigins = (process.env['CORS_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: isProd ? (corsOrigins.length ? corsOrigins : false) : true,
    credentials: true,
    exposedHeaders: ['etag', 'x-request-id', 'idempotent-replayed'],
  });

  await app.register(rateLimit, {
    global: false,
    redis: redisCore,
    nameSpace: 'rl:',
    keyGenerator: (req) => {
      const p = req.principal;
      if (p?.kind === 'staff') return `u:${p.userId}`;
      if (p?.kind === 'patient') return `cp:${p.contactPointId}`;
      if (p?.kind === 'device') return `d:${p.deviceId}`;
      return `ip:${req.ip}`;
    },
    // The plugin throws this object; statusCode makes the error handler map it to 429 problem+json (and keeps Retry-After).
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      ...toProblem(new AppError('rate_limited', `rate limit exceeded; retry after ${ctx.after}`), req.id),
    }),
  });

  if (opts.withDocs !== false) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Sahayak backend API',
          version: '1.0.0',
          description: 'AI-assisted OPD intake, triage, queue and doctor pre-brief platform.',
        },
        servers: [{ url: '/api/v1' }],
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            deviceKey: { type: 'apiKey', in: 'header', name: 'X-Device-Key' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    if (!isProd) await app.register(swaggerUi, { routePrefix: '/api/v1/docs' });
    app.get('/api/v1/openapi.json', { config: { public: true }, schema: { hide: true } }, async () => app.swagger());
  }

  const plain = app;
  if (opts.withAuth !== false) registerAuthHooks(plain);
  registerAuditHook(plain);
  registerIdempotencyHooks(plain);

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err, request_id: requestId }, 'request failed');
      return reply.code(err.status).header('content-type', 'application/problem+json').send(toProblem(err, requestId));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const e = new AppError('validation_failed', 'request validation failed', {
        errors: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
      return reply.code(400).header('content-type', 'application/problem+json').send(toProblem(e, requestId));
    }
    const anyErr = err;
    if (anyErr.statusCode === 429) {
      const detail = typeof anyErr.detail === 'string' ? anyErr.detail : 'rate limit exceeded';
      return reply
        .code(429)
        .header('content-type', 'application/problem+json')
        .send(toProblem(new AppError('rate_limited', detail), requestId));
    }
    if (anyErr.statusCode === 413 || anyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .header('content-type', 'application/problem+json')
        .send(toProblem(new AppError('payload_too_large'), requestId));
    }
    if (anyErr.statusCode && anyErr.statusCode >= 400 && anyErr.statusCode < 500) {
      return reply
        .code(anyErr.statusCode)
        .header('content-type', 'application/problem+json')
        .send(toProblem(new AppError('bad_request', anyErr.message, undefined, anyErr.statusCode), requestId));
    }
    if (anyErr.code === 'ECONNREFUSED' || anyErr.code === '57P01' || anyErr.code === '08006') {
      return reply
        .code(503)
        .header('retry-after', '5')
        .header('content-type', 'application/problem+json')
        .send(toProblem(new AppError('database_unavailable', 'database temporarily unavailable'), requestId));
    }
    req.log.error({ err, request_id: requestId }, 'unhandled error');
    return reply
      .code(500)
      .header('content-type', 'application/problem+json')
      .send(toProblem(new AppError('internal_error', 'unexpected error'), requestId));
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .header('content-type', 'application/problem+json')
      .send(toProblem(AppError.notFound('route'), req.id));
  });

  // Health (§11.2): liveness; readiness = Postgres + redis-core; Prometheus.
  app.get('/api/v1/healthz', { config: { public: true }, schema: { hide: true } }, async () => ({ status: 'ok', role: opts.role }));
  app.get('/api/v1/readyz', { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    const [dbOk, redisOk] = await Promise.all([opts.role === 'api' ? checkDatabase() : Promise.resolve(true), checkRedisCore()]);
    const ok = dbOk && redisOk;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', postgres: dbOk, redis_core: redisOk });
  });
  app.get('/api/v1/metrics', { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return renderMetrics();
  });

  return app;
}

export function registerShutdown(stop) {
  let stopping = false;
  const handler = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    try {
      await stop();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void handler('SIGTERM'));
  process.on('SIGINT', () => void handler('SIGINT'));
}

export { env };
