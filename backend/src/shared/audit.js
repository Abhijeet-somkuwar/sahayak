import { db } from '../infra/db.js';
import { toJson } from '../infra/db.types.js';
import { auditRows, auditWriteFailures } from '../infra/metrics.js';
import { logger } from '../infra/logger.js';
import { newId } from './ids.js';
import { AppError, toProblem } from './errors.js';

export function actorOf(p) {
  switch (p.kind) {
    case 'staff':
      return { kind: 'staff', id: p.userId };
    case 'patient':
      return { kind: 'patient', id: p.contactPointId };
    case 'device':
      return { kind: 'device', id: p.deviceId };
    default:
      return { kind: 'system', id: null };
  }
}

export class AuditCollector {
  entries = [];
  record(entry) {
    this.entries.push(entry);
  }
  get size() {
    return this.entries.length;
  }
  drain() {
    return this.entries.splice(0, this.entries.length);
  }
}

/** Insert audit rows now (workers, jobs, or the onSend hook). Uses the app pool; audit_events has no RLS. */
export async function writeAuditRows(entries, ctx) {
  if (entries.length === 0) return;
  await db
    .insertInto('audit_events')
    .values(
      entries.map((e) => ({
        id: newId(),
        actor_kind: ctx.actor.kind,
        actor_id: ctx.actor.id,
        facility_id: e.facilityId ?? ctx.defaultFacilityId ?? null,
        action: e.action,
        resource_type: e.resourceType,
        resource_id: e.resourceId ?? null,
        patient_id: e.patientId ?? null,
        purpose: e.purpose ?? null,
        request_id: ctx.requestId ?? null,
        ip: ctx.ip ?? null,
        details: toJson(e.details ?? {}),
      })),
    )
    .execute();
  for (const e of entries) auditRows.inc({ action: e.action });
}

/** Convenience for background jobs. */
export async function auditSystem(entry) {
  await writeAuditRows([entry], { actor: { kind: 'system', id: null } });
}

/** 🔒 Fastify hook: audit rows are written before the response is sent; failure → 500. */
export function registerAuditHook(app) {
  app.decorateRequest('audit', null);
  app.addHook('onRequest', async (req) => {
    req.audit = new AuditCollector();
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.audit || req.audit.size === 0) return payload;
    const entries = req.audit.drain();
    const p = req.principal ?? { kind: 'anonymous' };
    try {
      await writeAuditRows(entries, {
        actor: actorOf(p),
        requestId: req.requestId,
        ip: req.ip,
        defaultFacilityId: p.kind === 'device' ? p.facilityId : p.kind === 'staff' && p.facilityIds.length === 1 ? p.facilityIds[0] : null,
      });
      return payload;
    } catch (err) {
      auditWriteFailures.inc();
      logger.error({ err, request_id: req.requestId }, 'audit write failed; failing the request');
      reply.code(500).header('content-type', 'application/problem+json');
      return JSON.stringify(
        toProblem(new AppError('audit_write_failed', 'the access could not be audited, so it was refused'), req.requestId),
      );
    }
  });
}
