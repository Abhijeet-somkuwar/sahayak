/**
 * RBAC: static map from role to permission codes (§9.1). Each route declares one permission.
 */

export const ROLE_PERMISSIONS = {
  state_admin: ['state.analytics', 'facility.analytics', 'facility.configure', 'queue.read'],
  facility_admin: ['kb.manage', 'facility.configure', 'facility.analytics', 'queue.read'],
  doctor: [
    'queue.operate',
    'queue.read',
    'patient.demographics.read',
    'patient.demographics.write',
    'patient.clinical.read',
    'encounter.clinical.write',
    'encounter.vitals.write',
    'triage.override',
    'prealert.read',
    'doctor.status',
    'encounter.complete',
    'prebrief.feedback',
  ],
  nurse: [
    'queue.operate',
    'queue.checkin',
    'queue.read',
    'patient.demographics.read',
    'patient.demographics.write',
    'patient.clinical.read',
    'encounter.vitals.write',
    'triage.override',
    'prealert.read',
  ],
  registration_clerk: ['queue.checkin', 'queue.read', 'patient.demographics.read', 'patient.demographics.write'],
  help_desk: ['queue.checkin', 'queue.read', 'patient.demographics.read', 'patient.demographics.write'],
  pharmacist: ['queue.read', 'pharmacy.dispense'],
  lab_technician: ['queue.read'],
  clinical_reviewer: ['rules.author', 'rules.approve', 'templates.review'],
  dpo: ['audit.read'],
  auditor: ['audit.read'],
};

/** Roles for which TOTP MFA is mandatory (§9.1). */
export const MFA_REQUIRED_ROLES = new Set(['doctor', 'facility_admin', 'state_admin', 'dpo', 'clinical_reviewer']);

/** State-level roles have facility_id = NULL on their membership and see every facility (app.scope = 'state'). */
export const STATE_SCOPE_ROLES = new Set(['state_admin', 'auditor', 'dpo']);

export function hasPermission(memberships, permission, facilityId) {
  return memberships.some((m) => {
    if (!ROLE_PERMISSIONS[m.r]?.includes(permission)) return false;
    if (facilityId && m.f && m.f !== facilityId) return false;
    return true;
  });
}

export function rolesOf(memberships) {
  return [...new Set(memberships.map((m) => m.r))];
}

export function facilityIdsOf(memberships) {
  return [...new Set(memberships.map((m) => m.f).filter((f) => !!f))];
}

export function isStateScope(memberships) {
  return memberships.some((m) => m.f === null && STATE_SCOPE_ROLES.has(m.r));
}
