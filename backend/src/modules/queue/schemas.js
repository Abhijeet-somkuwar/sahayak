import { z } from 'zod';

export const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const checkIn = z
  .object({
    encounter_id: uuid.optional(), // booked encounter (QR scan)
    patient_id: uuid.optional(), // walk-in for a known patient
    preferred_doctor_id: uuid.nullable().optional(),
    source: z.enum(['counter', 'kiosk']).default('counter'),
    triage_level: z.enum(['priority', 'routine', 'self_care']).optional(), // staff-entered for walk-ins; never 'emergency' here
    protected_lane: z.boolean().optional(), // disability / pregnancy declared at the counter
  })
  .strict()
  .refine((v) => v.encounter_id || v.patient_id, { message: 'encounter_id or patient_id is required' });

export const callNext = z.object({ service_point_id: uuid.nullable().optional() }).strict();
export const transfer = z.object({ department_id: uuid, reason: z.string().max(200).optional() }).strict();
export const skip = z.object({ reason: z.string().max(200).optional() }).strict();

export const doctorStatus = z
  .object({ status: z.enum(['in_opd', 'on_rounds', 'in_surgery', 'on_break', 'off']), queue_session_id: uuid.nullable().optional() })
  .strict();

export const createEncounter = z
  .object({
    facility_id: uuid,
    patient_id: uuid,
    department_id: uuid,
    kind: z.enum(['opd_new', 'opd_followup']).default('opd_new'),
    triage_level: z.enum(['priority', 'routine']).default('routine'),
    complaint_codes: z.array(z.string()).default([]),
    check_in: z.boolean().default(true), // counter registration usually issues the token immediately
    shift: z.enum(['morning', 'evening']).optional(),
    preferred_doctor_id: uuid.nullable().optional(),
    protected_lane: z.boolean().optional(),
  })
  .strict();

export const observation = z
  .object({
    code: z.enum(['bp_systolic', 'bp_diastolic', 'pulse', 'temp_c', 'spo2', 'weight_kg', 'height_cm', 'rbs_mg_dl', 'resp_rate', 'other']),
    value_num: z.number().nullable().optional(),
    value_text: z.string().max(200).nullable().optional(),
    unit: z.string().max(16).nullable().optional(),
  })
  .strict()
  .refine((v) => v.value_num != null || v.value_text != null, { message: 'value_num or value_text required' });

export const diagnosis = z
  .object({
    code_system: z.enum(['icd10', 'snomed', 'local']).default('local'),
    code: z.string().max(32).nullable().optional(),
    display_text: z.string().min(1).max(300),
    is_primary: z.boolean().default(false),
  })
  .strict();

export const prescription = z
  .object({
    drug_code: z.string().max(64).nullable().optional(),
    drug_name: z.string().min(1).max(200),
    strength: z.string().max(64).nullable().optional(),
    dosage_form: z.string().max(64).nullable().optional(),
    dose: z.string().min(1).max(64),
    frequency: z.string().min(1).max(64),
    duration_days: z.number().int().positive().nullable().optional(),
    route: z.string().max(32).nullable().optional(),
    instructions_i18n: z.record(z.string(), z.string()).default({}), // written or approved by the doctor, never generated
  })
  .strict();

export const completeEncounter = z
  .object({
    followups: z
      .array(
        z.object({
          kind: z.enum(['symptom_checkin', 'medication_reminder', 'revisit_due', 'report_ready']),
          due_in_hours: z
            .number()
            .positive()
            .max(24 * 90)
            .optional(),
          reminder_times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).optional(),
          days: z.number().int().positive().max(90).optional(),
        }),
      )
      .default([]),
    referred: z.boolean().default(false),
  })
  .strict();

export const triageOverride = z
  .object({ final_level: z.enum(['emergency', 'priority', 'routine', 'self_care']), reason: z.string().min(5).max(500) })
  .strict();

export const tokenBlock = z.object({ queue_session_id: uuid, size: z.number().int().min(1).max(100).optional() }).strict();
export const offlineTokens = z
  .object({
    queue_session_id: uuid,
    device_time: z.string().datetime(),
    tokens: z
      .array(
        z.object({
          client_id: uuid, // client-generated UUIDv7
          token_no: z.number().int().positive(),
          issued_at: z.string().datetime(),
          patient_id: uuid.optional(),
          patient: z
            .object({
              display_name: z.string().min(1).max(200),
              sex: z.enum(['female', 'male', 'other', 'unknown']).default('unknown'),
              age_years: z.number().int().min(0).max(120),
              phone: z.string().optional(),
            })
            .optional(),
          lane: z.number().int().min(0).max(2).default(2),
        }),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const sessionDate = z.object({ date: dateStr.optional() });
