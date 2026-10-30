/** stats-rollup (§9.11): every 15 min for today (is_final=false); 01:00 IST for yesterday (is_final=true). */
import { withMaint } from '../../infra/db.js';
import { istDate, addDays } from '../../shared/time.js';
import { analyticsRepo } from './repo.js';

export async function runStatsRollup(opts) {
  const statDate = opts.final ? addDays(istDate(), -1) : istDate();
  await withMaint(async (trx) => {
    // rollups touch every facility; the owner role bypasses RLS like other system jobs
    await analyticsRepo.rollupTokens(trx, statDate, opts.final);
    await analyticsRepo.rollupEncounters(trx, statDate, opts.final);
    await analyticsRepo.rollupHourly(trx, statDate);
  });
  return statDate;
}
