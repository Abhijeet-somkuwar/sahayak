/**
 * Audit & compliance (§9.12): Q14, break-glass review queue, consent ledger, hourly tamper-evidence digests,
 * data-principal requests (access / correction / erasure with recorded decisions).
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { sha256 } from '../../infra/crypto.js';
import { putObject, storageKeys } from '../../infra/storage.js';
import { logger } from '../../infra/logger.js';
import { boundaryMonthsAgo } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { auditRepo } from './repo.js';

export const auditService = {
  accessLog: (trx, patientId) => auditRepo.accessLog(trx, patientId, boundaryMonthsAgo(12)),
  breakglassQueue: (trx, status) => auditRepo.breakglassEvents(trx, boundaryMonthsAgo(6), status === 'reviewed'),

  /** Hourly audit-digest: sha256(prev_digest || sha256 of the period's rows in id order), exported as JSONL.gz to write-once storage. */
  async runDigest(now = new Date()) {
    const periodEnd = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000); // start of the current hour
    const periodStart = new Date(periodEnd.getTime() - 3_600_000);
    return withScope(STATE_SCOPE, async (trx) => {
      const last = await auditRepo.lastDigest(trx);
      if (last && last.period_start.getTime() >= periodStart.getTime()) return null;
      const rows = await auditRepo.rowsForPeriod(trx, periodStart, periodEnd);
      const rowsHash = sha256(Buffer.concat(rows.map((r) => sha256(JSON.stringify(r)))));
      const digest = sha256(Buffer.concat([last?.digest ?? Buffer.alloc(0), rowsHash]));
      let exportedTo = null;
      try {
        exportedTo = await putObject(storageKeys.auditExport(periodStart.toISOString()), auditRepo.gzipJsonl(rows), 'application/gzip', {
          digest: digest.toString('hex'),
          rows: String(rows.length),
        });
      } catch (err) {
        logger.warn({ err }, 'audit export to object storage failed; digest still recorded');
      }
      await auditRepo.insertDigest(trx, {
        period_start: periodStart,
        period_end: periodEnd,
        row_count: rows.length,
        digest,
        prev_digest: last?.digest ?? null,
        exported_to: exportedTo,
      });
      return { period_start: periodStart.toISOString(), rows: rows.length };
    });
  },

  /**
   * 🔒 Erasure: anonymise non-clinical data (contact points, conversations, messages) but keep clinical records the
   * hospital must legally retain. Every decision is recorded as an audit row by the caller.
   */
  async eraseNonClinical(trx, contactPointId) {
    if (!(await auditRepo.contactPointExists(trx, contactPointId))) throw AppError.notFound('contact point');
    const convs = await auditRepo.conversationsForContact(trx, contactPointId);
    let messages = 0;
    for (const c of convs) {
      messages += await auditRepo.eraseMessages(trx, c.id);
      await auditRepo.detachConversation(trx, c.id);
    }
    await auditRepo.tombstoneContactPoint(trx, contactPointId, sha256(`erased:${contactPointId}:${Date.now()}`));
    return { conversations: convs.length, messages };
  },
};
