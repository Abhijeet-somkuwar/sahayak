import { roundTo5Minutes } from '../../shared/time.js';

export const LANE_URGENT = 0,
  LANE_PROTECTED = 1,
  LANE_GENERAL = 2;

/** 🔒 Triage 'emergency' never enters an OPD queue; callers must reject it before calling this. */
export function assignLane(i) {
  if (i.triageLevel === 'emergency') throw new Error('emergency never enters an OPD queue');
  if (i.triageLevel === 'priority') return LANE_URGENT;
  if (i.ageYears >= (i.protectedMinAge ?? 60) || i.pregnant || i.disability) return LANE_PROTECTED;
  return LANE_GENERAL;
}

// epoch ms

/**
 * selectLane(meta, heads):
 *   if lane0 not empty: return 0
 *   oldest = lane head (1 or 2) with the earliest queue_entry_at
 *   if now - oldest.queue_entry_at > max_wait_minutes: return oldest.lane         -- aging guard
 *   protectedShareBehind = served_protected * ratio_general <= served_general * ratio_protected
 *   if protectedShareBehind and lane1 not empty: return 1
 *   if lane2 not empty: return 2
 *   return lane1 not empty ? 1 : none
 */
export function selectLane(meta, heads, maxWaitMinutes, now = Date.now()) {
  const head = (lane) => heads.find((h) => h.lane === lane);
  if (head(LANE_URGENT)) return LANE_URGENT;
  const candidates = [head(LANE_PROTECTED), head(LANE_GENERAL)].filter((h) => !!h);
  if (candidates.length === 0) return null;
  const oldest = candidates.reduce((a, b) => (a.queueEntryAt <= b.queueEntryAt ? a : b));
  if (now - oldest.queueEntryAt > maxWaitMinutes * 60_000) return oldest.lane;
  const rp = Math.max(meta.ratioProtected, 1),
    rg = Math.max(meta.ratioGeneral, 1);
  const protectedShareBehind = meta.servedProtected * rg <= meta.servedGeneral * rp;
  if (protectedShareBehind && head(LANE_PROTECTED)) return LANE_PROTECTED;
  if (head(LANE_GENERAL)) return LANE_GENERAL;
  return head(LANE_PROTECTED) ? LANE_PROTECTED : null;
}

/** Lane order to try after the selected one (Q5 may return no row if another doctor took the last token). */
export function laneFallbackOrder(selected) {
  return [selected, ...[LANE_URGENT, LANE_PROTECTED, LANE_GENERAL].filter((l) => l !== selected)];
}

/** EWMA with α = 0.2, clamped to [30 s, 30 min] to ignore outliers. */
export function updateEwma(current, consultSeconds, alpha = 0.2) {
  const clamped = Math.min(1800, Math.max(30, consultSeconds));
  return Math.round(alpha * clamped + (1 - alpha) * (current || clamped));
}

/** 🔒 Never a single exact time: [0.8 × eta, 1.3 × eta], rounded to 5 minutes. */
export function etaRange(etaSeconds, activeServers, sessionStartsAt, now = new Date()) {
  if (activeServers <= 0) return { min_minutes: 0, max_minutes: 0, doctor_unavailable: true };
  const offset = sessionStartsAt ? Math.max(0, (sessionStartsAt.getTime() - now.getTime()) / 1000) : 0;
  const total = etaSeconds + offset;
  return { min_minutes: roundTo5Minutes(total * 0.8), max_minutes: Math.max(5, roundTo5Minutes(total * 1.3)), doctor_unavailable: false };
}

/** People ahead → BullMQ priority for the pre-brief job (lower number = sooner). */
export function prebriefPriority(ahead) {
  return Math.min(1_000_000, Math.max(1, ahead + 1));
}
