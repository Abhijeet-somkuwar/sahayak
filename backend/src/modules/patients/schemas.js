import { z } from 'zod';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const sex = z.enum(['female', 'male', 'other', 'unknown']);
export const relationship = z.enum(['self', 'parent', 'child', 'spouse', 'sibling', 'other_family', 'caregiver', 'asha_worker']);
export const consentPurpose = z.enum([
  'care_coordination',
  'ai_assisted_intake',
  'history_sharing',
  'whatsapp_notifications',
  'deidentified_analytics',
]);

export const searchQuery = z
  .object({
    phone: z.string().min(10).max(20).optional(),
    abha: z.string().min(14).max(20).optional(),
    mrn: z.string().max(64).optional(),
    facility_id: z.string().uuid().optional(),
    name: z.string().min(2).max(100).optional(),
    district: z.string().max(16).optional(),
    birth_year: z.coerce.number().int().min(1900).max(2100).optional(),
  })
  .strict();

export const createPatient = z
  .object({
    display_name: z.string().min(1).max(200),
    sex: sex.default('unknown'),
    birth_date: dateStr.nullable().optional(),
    age_years: z.number().int().min(0).max(120).optional(), // when only an approximate age is known
    preferred_language: z.string().max(10).default('hi'),
    district_code: z.string().max(16).nullable().optional(),
    pincode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable()
      .optional(),
    address: z.string().max(500).nullable().optional(),
    phone: z.string().min(10).max(20).optional(), // links a contact point
    relationship: relationship.default('self'),
    abha_number: z.string().min(14).max(20).optional(),
    facility_mrn: z.string().max(64).optional(),
    force: z.boolean().default(false), // skip the duplicate check after reviewing candidates
  })
  .strict()
  .refine((v) => v.birth_date || v.age_years !== undefined, { message: 'birth_date or age_years is required' });

export const linkContact = z.object({ phone: z.string().min(10).max(20), relationship, is_primary: z.boolean().default(false) }).strict();

export const recordConsent = z
  .object({
    phone: z.string().min(10).max(20).optional(),
    contact_point_id: z.string().uuid().optional(),
    patient_id: z.string().uuid().nullable().default(null),
    purpose: consentPurpose,
    granted: z.boolean(),
    notice_version: z.string().min(1).max(32),
    language: z.string().max(10),
  })
  .strict();

export const createAllergy = z
  .object({
    substance_text: z.string().min(1).max(200),
    substance_code: z.string().max(64).nullable().default(null),
    reaction: z.string().max(200).nullable().default(null),
    severity: z.enum(['mild', 'moderate', 'severe', 'unknown']).default('unknown'),
    encounter_id: z.string().uuid().nullable().default(null),
  })
  .strict();

export const createCondition = z
  .object({
    display_text: z.string().min(1).max(200),
    code_system: z.enum(['icd10', 'snomed', 'local']).default('local'),
    code: z.string().max(32).nullable().default(null),
    is_chronic: z.boolean().default(false),
    onset_date: dateStr.nullable().default(null),
    expires_at: dateStr.nullable().default(null),
    encounter_id: z.string().uuid().nullable().default(null),
  })
  .strict();

export const breakGlass = z.object({ reason: z.string().min(10).max(500) }).strict();
export const mergePatients = z.object({ into_patient_id: z.string().uuid(), reason: z.string().min(5).max(500) }).strict();
