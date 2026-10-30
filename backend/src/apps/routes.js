import { authRoutes } from '../modules/auth/routes.js';
import { facilitiesRoutes } from '../modules/facilities/routes.js';
import { patientsRoutes } from '../modules/patients/routes.js';
import { queueRoutes } from '../modules/queue/routes.js';
import { intakeRoutes } from '../modules/intake/routes.js';
import { triageRoutes } from '../modules/triage/routes.js';
import { prebriefRoutes } from '../modules/prebrief/routes.js';
import { kbRoutes } from '../modules/kb/routes.js';
import { patientDocsRoutes } from '../modules/patientdocs/routes.js';
import { followupsRoutes } from '../modules/followups/routes.js';
import { analyticsRoutes } from '../modules/analytics/routes.js';
import { auditRoutes } from '../modules/audit/routes.js';
import { adminRoutes } from '../modules/admin/routes.js';
import { devicesRoutes } from '../modules/devices/routes.js';
import { devRoutes } from '../modules/dev/routes.js'; // development-only demo helpers; registers nothing in production

export async function registerApiRoutes(app) {
  for (const r of [
    authRoutes,
    facilitiesRoutes,
    patientsRoutes,
    queueRoutes,
    intakeRoutes,
    triageRoutes,
    prebriefRoutes,
    kbRoutes,
    patientDocsRoutes,
    followupsRoutes,
    analyticsRoutes,
    auditRoutes,
    adminRoutes,
    devicesRoutes,
    devRoutes,
  ]) {
    await app.register(r);
  }
}
