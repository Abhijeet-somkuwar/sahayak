/**
 * Per-facility feature flags stored in facilities.opd_config (§14.7).
 * Turning AI off never requires a deploy.
 */
import { z } from 'zod';

export const opdConfigSchema = z
  .object({
    ai_intake_enabled: z.boolean().default(true),
    prebrief_ai_enabled: z.boolean().default(true),
    kb_llm_enabled: z.boolean().default(true),
    remote_booking_enabled: z.boolean().default(true),
    offline_blocks_enabled: z.boolean().default(true),
    registration_hours: z
      .object({ start: z.string().default('08:00'), end: z.string().default('13:00') })
      .default({ start: '08:00', end: '13:00' }),
    lane_ratio: z.tuple([z.number().int().positive(), z.number().int().positive()]).default([1, 2]),
    reporting_window_minutes: z.number().int().positive().default(30),
    max_wait_minutes: z.number().int().positive().default(120), // aging guard (§9.5.4)
    requeue_penalty_minutes: z.number().int().nonnegative().default(15),
    offline_block_size: z.number().int().positive().default(20),
    default_eta_seconds: z.number().int().positive().default(300),
    help_desk_phone: z.string().default(''),
    protected_lane_min_age: z.number().int().positive().default(60),
  })
  .passthrough();

export function parseOpdConfig(raw) {
  const r = opdConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : opdConfigSchema.parse({});
}
