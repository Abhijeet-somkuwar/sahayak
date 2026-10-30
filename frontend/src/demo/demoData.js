// Plain-language descriptions of the demo accounts, shared by the Demo panel, the guide page and the sign-in page.
// The accounts themselves come from the development backend (GET /dev/demo); nothing here is a credential.

export const ROLE_INFO = {
  registration_clerk: {
    title: 'Registration clerk',
    plain: 'Sits at the registration counter. Finds or registers walk-in patients and gives them a token number.',
    home: '/counter',
  },
  help_desk: {
    title: 'Help desk',
    plain: 'Uses the same counter screen to help people: register someone, check a patient in, answer questions.',
    home: '/counter',
  },
  nurse: {
    title: 'Staff nurse',
    plain: 'Can open the counter, the doctor’s queue and the casualty alerts. Needs no authenticator code.',
    home: '/doctor',
  },
  doctor: {
    title: 'Doctor',
    plain: 'Calls the next patient, reads the short summary prepared before the patient walks in, writes diagnosis and prescription.',
    home: '/doctor',
  },
  facility_admin: {
    title: 'Hospital administrator',
    plain: 'Can open every screen. Staff, devices and schedules are managed through the API (no admin screens yet).',
    home: '/counter',
  },
  clinical_reviewer: { title: 'Clinical reviewer', plain: 'Approves the triage rules and patient messages. API only, no screen yet.', home: null },
  dpo: { title: 'Data protection officer', plain: 'Checks who opened which patient record. API only, no screen yet.', home: null },
  state_admin: { title: 'State administrator', plain: 'Sees statistics across hospitals. API only, no screen yet.', home: null },
};

/** The screen a demo account opens on. */
export const homeOf = (s) => (s.department_code === 'CASUALTY' ? '/ed' : (ROLE_INFO[s.role] || {}).home || null);

/** "Doctor, Medicine OPD", "Casualty doctor", "Registration clerk"… */
export function titleOf(s) {
  if (s.role === 'doctor') return s.department_code === 'CASUALTY' ? 'Casualty doctor' : `Doctor, ${s.department}`;
  if (s.role === 'nurse' && s.department) return `Staff nurse, ${s.department}`;
  return (ROLE_INFO[s.role] || {}).title || s.role;
}

export const plainOf = (s) =>
  s.department_code === 'CASUALTY' ? 'Sees the casualty alerts raised when a patient reports danger signs.' : (ROLE_INFO[s.role] || {}).plain || '';

/** Opens a tab signed in as this account, on its own screen (LoginPage handles ?as= in demo mode). */
export const loginUrl = (s, screen) => `/login?as=${encodeURIComponent(s.email)}&returnTo=${encodeURIComponent(screen || homeOf(s) || '/counter')}`;

export const findStaff = (demo, prefix) => (demo ? demo.staff.find((x) => x.email.startsWith(prefix)) : null);
export const findDevice = (demo, kind) => (demo ? demo.devices.find((d) => d.kind === kind) : null);

/** Accounts shown first in the panel, in this order; the rest are grouped. */
export const PRIMARY = ['clerk@', 'dr.mehta@', 'nurse@', 'helpdesk@', 'dr.rao@', 'admin@'];

export const formatPhone = (p) => `${p.slice(0, 5)} ${p.slice(5)}`;
