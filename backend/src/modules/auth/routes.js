import { isProd } from '../../config/env.js';
import { requireStaff, requirePatient } from '../../shared/auth.js';
import { authService } from './service.js';
import * as S from './schemas.js';

export async function authRoutes(app) {
  app.post(
    '/api/v1/auth/staff/login',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], body: S.staffLogin },
    },
    async (req) =>
      authService.staffLogin(req.body.identifier, req.body.password, { ip: req.ip, deviceLabel: req.body.device_label, audit: req.audit }),
  );

  app.post(
    '/api/v1/auth/staff/mfa/enrol',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: S.mfaEnrol } },
    async (req) => authService.mfaEnrol(req.body.mfa_token),
  );

  app.post(
    '/api/v1/auth/staff/mfa/verify',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: S.mfaVerify } },
    async (req) => authService.mfaVerify(req.body.mfa_token, req.body.code, { ip: req.ip, audit: req.audit }),
  );

  // Development only (mirrors dev_code on the patient OTP): the current authenticator code for the account behind
  // an MFA-pending token, so a developer can sign in without an authenticator app. Not registered in production.
  if (!isProd)
    app.post(
      '/api/v1/auth/staff/mfa/dev-code',
      { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: S.mfaEnrol } },
      async (req) => authService.mfaDevCode(req.body.mfa_token),
    );

  app.post(
    '/api/v1/auth/refresh',
    { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: S.refresh } },
    async (req) => authService.refresh(req.body.refresh_token, { ip: req.ip, audit: req.audit }),
  );

  app.post('/api/v1/auth/logout', { schema: { tags: ['auth'], body: S.logout } }, async (req, reply) => {
    const staff = requireStaff(req);
    await authService.logout(staff.userId, req.body.refresh_token, req.audit);
    return reply.code(204).send();
  });

  app.get('/api/v1/me', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } }, schema: { tags: ['auth'] } }, async (req) => {
    if (req.principal.kind === 'patient') {
      requirePatient(req);
      return { kind: 'patient', contact_point_id: req.principal.contactPointId, language: req.principal.language };
    }
    const staff = requireStaff(req);
    return { kind: 'staff', ...(await authService.me(staff.userId)) };
  });

  app.post(
    '/api/v1/auth/patient/otp',
    {
      // per IP; 3 per phone per 10 min enforced in the service. Development allows more: every demo tab shares one IP.
      config: { public: true, rateLimit: { max: isProd ? 20 : 300, timeWindow: '1 hour' } },
      schema: { tags: ['auth'], body: S.patientOtp },
    },
    async (req) => authService.requestPatientOtp(req.body.phone, req.body.language),
  );

  app.post(
    '/api/v1/auth/patient/otp/verify',
    { config: { public: true, rateLimit: { max: isProd ? 30 : 300, timeWindow: '10 minutes' } }, schema: { tags: ['auth'], body: S.patientOtpVerify } },
    async (req) => authService.verifyPatientOtp(req.body.phone, req.body.code, req.body.language),
  );
}
