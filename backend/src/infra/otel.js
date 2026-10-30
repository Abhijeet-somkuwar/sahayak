/**
 * OpenTelemetry (§15): auto-instrumentation for Fastify, pg, ioredis and outbound HTTP.
 * Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set; sampling (10% + all errors) is configured at the collector.
 */
import { context, propagation } from '@opentelemetry/api';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let started = false;

export async function startTelemetry(role) {
  if (started || !env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  started = true;
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const sdk = new NodeSDK({
      serviceName: `${env.SERVICE_NAME}-${role}`,
      traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
    });
    sdk.start();
    process.once('SIGTERM', () => {
      void sdk.shutdown();
    });
    logger.info({ role }, 'telemetry started');
  } catch (err) {
    logger.warn({ err }, 'telemetry could not start');
  }
}

/** Carry the producer's trace context in BullMQ job data so a message can be followed webhook → reply (§15). */
export function currentTraceContext() {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}
