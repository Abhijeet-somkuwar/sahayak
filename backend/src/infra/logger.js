/**
 * pino JSON logger with PHI redaction (§15). No names, phone numbers, message bodies or tokens in logs.
 */
import pino from 'pino';
import { env, isProd } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-device-key"]',
  'headers.authorization',
  '*.phone',
  '*.phone_number',
  '*.wa_id',
  '*.display_name',
  '*.name',
  '*.address',
  '*.abha',
  '*.abha_number',
  '*.body',
  '*.text',
  '*.message',
  '*.complaint',
  '*.free_text',
  '*.transcript',
  '*.password',
  '*.otp',
  '*.token',
  'phone',
  'display_name',
  'address',
  'body',
  'text',
  'password',
  'otp',
  'token',
  '*.messages[*].text',
  '*.entry[*].changes[*].value.messages[*]',
  '*.entry[*].changes[*].value.contacts[*]',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: env.SERVICE_NAME, role: process.env['SAHAYAK_ROLE'] ?? 'unknown' },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  transport:
    !isProd && env.NODE_ENV !== 'test' && process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});
