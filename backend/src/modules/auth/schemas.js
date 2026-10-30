import { z } from 'zod';

export const staffLogin = z
  .object({
    identifier: z.string().min(3).max(200), // email or phone
    password: z.string().min(8).max(200),
    device_label: z.string().max(100).optional(),
  })
  .strict();

export const mfaVerify = z.object({ mfa_token: z.string().min(10), code: z.string().regex(/^\d{6}$/) }).strict();
export const mfaEnrol = z.object({ mfa_token: z.string().min(10) }).strict();
export const refresh = z.object({ refresh_token: z.string().min(20) }).strict();
export const logout = z.object({ refresh_token: z.string().min(20).optional() }).strict();

export const patientOtp = z.object({ phone: z.string().min(10).max(20), language: z.string().max(10).default('hi') }).strict();
export const patientOtpVerify = z
  .object({ phone: z.string().min(10).max(20), code: z.string().regex(/^\d{6}$/), language: z.string().max(10).default('hi') })
  .strict();

export const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
});
