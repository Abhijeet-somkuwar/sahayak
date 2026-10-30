import { z } from 'zod';

export const i18n = z.record(z.string(), z.string()).default({});
export const uuid = z.string().uuid();

export const createDepartment = z
  .object({
    code: z.string().min(1).max(32),
    specialty_code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    name_i18n: i18n,
    token_prefix: z.string().min(1).max(8),
    is_emergency: z.boolean().default(false),
    accepts_routing: z.boolean().default(true),
    default_consult_seconds: z.number().int().min(30).max(3600).default(300),
    display_order: z.number().int().default(0),
  })
  .strict();
export const updateDepartment = createDepartment
  .partial()
  .extend({ status: z.enum(['active', 'inactive']).optional() })
  .strict();

export const createServicePoint = z
  .object({
    department_id: uuid.nullable().default(null),
    kind: z.enum(['consult_room', 'registration_counter', 'triage_desk', 'lab', 'radiology', 'pharmacy', 'help_desk', 'emergency_bay']),
    label: z.string().min(1).max(100),
    label_i18n: i18n,
    floor: z.string().max(50).nullable().default(null),
    wayfinding_i18n: i18n,
  })
  .strict();
export const updateServicePoint = createServicePoint
  .partial()
  .extend({ status: z.enum(['active', 'inactive']).optional() })
  .strict();

const hhmm = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
export const createSchedule = z
  .object({
    department_id: uuid,
    user_id: uuid,
    service_point_id: uuid.nullable().default(null),
    weekday: z.number().int().min(1).max(7),
    shift: z.enum(['morning', 'evening']),
    starts_at: hhmm,
    ends_at: hhmm,
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effective_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
  })
  .strict();

export const createOverride = z
  .object({
    user_id: uuid,
    on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(['leave', 'extra_duty', 'emergency_duty', 'rounds_extended']),
    starts_at: hhmm.nullable().default(null),
    ends_at: hhmm.nullable().default(null),
    note: z.string().max(500).nullable().default(null),
  })
  .strict();

export const updateFacilityConfig = z
  .object({
    name: z.string().min(1).max(200).optional(),
    name_i18n: i18n.optional(),
    address: z.string().max(500).nullable().optional(),
    pincode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable()
      .optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    opd_config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createFacility = z
  .object({
    code: z.string().min(2).max(32),
    name: z.string().min(1).max(200),
    name_i18n: i18n,
    kind: z.enum(['medical_college', 'district_hospital', 'sub_district_hospital', 'chc', 'phc', 'uphc', 'other']),
    state_code: z.string().length(2),
    district_code: z.string().min(1).max(16),
    hfr_id: z.string().max(64).nullable().default(null),
    address: z.string().max(500).nullable().default(null),
    pincode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable()
      .default(null),
    latitude: z.number().nullable().default(null),
    longitude: z.number().nullable().default(null),
    opd_config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
