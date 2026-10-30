import { describe, expect, it } from 'vitest';
import {
  assignLane,
  etaRange,
  laneFallbackOrder,
  prebriefPriority,
  selectLane,
  updateEwma,
  LANE_GENERAL,
  LANE_PROTECTED,
  LANE_URGENT,
} from '../../src/modules/queue/lanes.js';

describe('lane assignment (§9.5.1)', () => {
  it('priority → urgent; 60+/pregnant/disability → protected; else general', () => {
    expect(assignLane({ triageLevel: 'priority', ageYears: 30 })).toBe(LANE_URGENT);
    expect(assignLane({ triageLevel: 'routine', ageYears: 65 })).toBe(LANE_PROTECTED);
    expect(assignLane({ triageLevel: 'routine', ageYears: 25, pregnant: true })).toBe(LANE_PROTECTED);
    expect(assignLane({ triageLevel: 'routine', ageYears: 25, disability: true })).toBe(LANE_PROTECTED);
    expect(assignLane({ triageLevel: 'routine', ageYears: 25 })).toBe(LANE_GENERAL);
    expect(assignLane({ triageLevel: null, ageYears: 25 })).toBe(LANE_GENERAL);
  });
  it('🔒 emergency never enters a queue', () => {
    expect(() => assignLane({ triageLevel: 'emergency', ageYears: 30 })).toThrow();
  });
});

describe('lane selection (§9.5.4)', () => {
  const now = 1_000_000_000;
  const meta = { ratioProtected: 1, ratioGeneral: 2, servedProtected: 0, servedGeneral: 0 };
  it('urgent lane always first', () => {
    expect(
      selectLane(
        meta,
        [
          { lane: 0, queueEntryAt: now },
          { lane: 1, queueEntryAt: now - 1 },
          { lane: 2, queueEntryAt: now - 2 },
        ],
        120,
        now,
      ),
    ).toBe(0);
  });
  it('shares protected:general 1:2', () => {
    const heads = [
      { lane: 1, queueEntryAt: now },
      { lane: 2, queueEntryAt: now },
    ];
    expect(selectLane({ ...meta, servedProtected: 0, servedGeneral: 0 }, heads, 120, now)).toBe(1); // 0*2 <= 0*1 → protected behind
    expect(selectLane({ ...meta, servedProtected: 1, servedGeneral: 0 }, heads, 120, now)).toBe(2); // 2 <= 0 false → general
    expect(selectLane({ ...meta, servedProtected: 1, servedGeneral: 1 }, heads, 120, now)).toBe(2); // 2 <= 1 false
    expect(selectLane({ ...meta, servedProtected: 1, servedGeneral: 2 }, heads, 120, now)).toBe(1); // 2 <= 2 true
  });
  it('aging guard: oldest head beyond max wait wins', () => {
    const heads = [
      { lane: 1, queueEntryAt: now },
      { lane: 2, queueEntryAt: now - 121 * 60_000 },
    ];
    expect(selectLane({ ...meta, servedProtected: 0, servedGeneral: 0 }, heads, 120, now)).toBe(2);
  });
  it('falls back to the only non-empty lane and to none', () => {
    expect(selectLane({ ...meta, servedProtected: 5, servedGeneral: 0 }, [{ lane: 1, queueEntryAt: now }], 120, now)).toBe(1);
    expect(selectLane(meta, [], 120, now)).toBeNull();
    expect(laneFallbackOrder(1)).toEqual([1, 0, 2]);
  });
});

describe('ETA maths (§8.3, §9.5.6)', () => {
  it('EWMA α=0.2 with clamping', () => {
    expect(updateEwma(300, 500)).toBe(340);
    expect(updateEwma(300, 5)).toBe(246); // clamped to 30 s
    expect(updateEwma(300, 10_000)).toBe(600); // clamped to 1800 s
  });
  it('🔒 ETA is a range rounded to 5 minutes, never an exact time', () => {
    const r = etaRange(1800, 1);
    expect(r).toEqual({ min_minutes: 25, max_minutes: 40, doctor_unavailable: false });
    expect(etaRange(600, 0).doctor_unavailable).toBe(true);
    const later = etaRange(600, 1, new Date(Date.now() + 3600_000));
    expect(later.min_minutes).toBeGreaterThanOrEqual(55);
  });
  it('pre-brief priority = people ahead + 1', () => {
    expect(prebriefPriority(0)).toBe(1);
    expect(prebriefPriority(41)).toBe(42);
  });
});
