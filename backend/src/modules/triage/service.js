/**
 * Rule-set governance (§9.4): draft → tests pass → approval by a different clinical reviewer (four-eyes, also a DB
 * constraint) → publish in one transaction (retire current, publish new) → INCR rulesver + rules:published pub/sub.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { redisCore, keys } from '../../infra/redis.js';
import { AppError } from '../../shared/errors.js';
import { writeOutbox } from '../../shared/outbox.js';
import { ruleSetChecksum, ruleSetSchema, runTestCases, testCaseSchema } from './engine.js';
import { triageRepo } from './repo.js';
import { z } from 'zod';

let cached = null;

/** In-memory copy of the published rule set, reloaded when the Redis rulesver counter changes. */
export async function getPublishedRuleSet() {
  const ver = (await redisCore.get(keys.rulesver).catch(() => null)) ?? '0';
  if (cached && cached.ver === ver) return cached.set;
  const row = await withScope(STATE_SCOPE, (trx) => triageRepo.published(trx));
  if (!row) throw new AppError('service_unavailable', 'no published triage rule set; publish one before running intake');
  const set = { id: row.id, version: row.version, rules: ruleSetSchema.parse(row.rules) };
  cached = { set, ver };
  return set;
}

export function invalidateRuleSetCache() {
  cached = null;
}

export const triageService = {
  getPublished: getPublishedRuleSet,

  async createDraft(trx, input, authoredBy) {
    const rules = ruleSetSchema.parse(input.rules);
    const cases = z.array(testCaseSchema).parse(input.test_cases);
    const version = await triageRepo.nextVersion(trx);
    return triageRepo.insert(trx, {
      version,
      rules,
      test_cases: cases,
      checksum: ruleSetChecksum(rules),
      authored_by: authoredBy,
      notes: input.notes ?? null,
    });
  },

  async test(trx, id) {
    const row = await triageRepo.byId(trx, id);
    if (!row) throw AppError.notFound('rule set');
    return runTestCases(ruleSetSchema.parse(row.rules), z.array(testCaseSchema).parse(row.test_cases));
  },

  async approve(trx, id, approvedBy) {
    const row = await triageRepo.byId(trx, id);
    if (!row) throw AppError.notFound('rule set');
    if (row.status !== 'draft') throw new AppError('invalid_state', `rule set v${row.version} is ${row.status}`);
    if (row.authored_by === approvedBy) throw AppError.forbidden('four-eyes: the author cannot approve their own rule set');
    const result = runTestCases(ruleSetSchema.parse(row.rules), z.array(testCaseSchema).parse(row.test_cases));
    if (!result.passed)
      throw new AppError('invalid_state', 'all test cases must pass before approval', {
        failed: result.results.filter((r) => !r.passed).map((r) => r.name),
      });
    const updated = await triageRepo.approve(trx, id, approvedBy);
    if (!updated) throw new AppError('invalid_state', 'rule set could not be approved');
    return updated;
  },

  async publish(trx, id, publishedBy) {
    const row = await triageRepo.byId(trx, id);
    if (!row) throw AppError.notFound('rule set');
    if (row.status !== 'draft') throw new AppError('invalid_state', `rule set v${row.version} is ${row.status}`);
    if (!row.approved_by) throw new AppError('invalid_state', 'rule set must be approved before publishing');
    const result = runTestCases(ruleSetSchema.parse(row.rules), z.array(testCaseSchema).parse(row.test_cases));
    if (!result.passed) throw new AppError('invalid_state', 'all test cases must pass before publishing');
    await triageRepo.retireCurrent(trx);
    const published = await triageRepo.publish(trx, id);
    if (!published) throw new AppError('invalid_state', 'publish failed');
    await writeOutbox(trx, {
      aggregateType: 'triage_rule_set',
      aggregateId: id,
      eventType: 'rules.published',
      payload: { version: row.version, publishedBy },
    });
    return published;
  },

  /** Called by the outbox relay after commit. */
  async afterPublish() {
    await redisCore.incr(keys.rulesver);
    await redisCore.publish(keys.chRulesPublished, String(Date.now()));
    invalidateRuleSetCache();
  },
};
