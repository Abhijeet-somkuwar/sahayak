/**
 * summary-rebuild job (§9.2, §12.1): debounced per patient; increments source_version so the cache key changes.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { enqueue } from '../../infra/queues.js';
import { patientsService } from './service.js';

export async function scheduleSummaryRebuild(patientId) {
  // Debounce per patient within a 5-second bucket. A plain jobId of the patient id would be ignored by BullMQ for as
  // long as the previous completed job is retained (1 h), so the rebuild after "Complete" was silently skipped.
  const bucket = Math.floor(Date.now() / 5_000);
  await enqueue('summary-rebuild', 'rebuild', { patientId }, { jobId: `${patientId}:${bucket}`, delay: 5_000 });
}

export async function runSummaryRebuild(data) {
  await withScope(STATE_SCOPE, (trx) => patientsService.rebuildSummary(trx, data.patientId));
}
