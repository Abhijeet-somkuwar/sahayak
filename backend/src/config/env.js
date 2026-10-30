/**
 * Environment configuration, validated with Zod (§13.7, §19).
 * The app refuses to start if a required secret is missing.
 */
import 'dotenv/config';
import { z } from 'zod';

const base64Key = (bytes) =>
  z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    { message: `must be base64 of exactly ${bytes} bytes` },
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    APP_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    SERVICE_NAME: z.string().default('sahayak'),

    DATABASE_URL: z.string().url(),
    DATABASE_URL_MAINT: z.string().url(),
    DATABASE_REPLICA_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),

    REDIS_CORE_URL: z.string().url(),
    REDIS_CACHE_URL: z.string().url(),

    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('ap-south-1'),
    S3_BUCKET: z.string().default('sahayak'),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),

    KMS_KEY_ID: z.string().optional(),
    DEV_MASTER_KEY: base64Key(32).optional(),
    BLIND_INDEX_KEY: base64Key(32),
    JWT_PRIVATE_KEY: z.string().min(1), // PKCS8 PEM (Ed25519), optionally base64-encoded
    JWT_PUBLIC_KEY: z.string().min(1), // SPKI PEM (Ed25519), optionally base64-encoded
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),

    WA_APP_SECRET: z.string().min(1),
    WA_VERIFY_TOKEN: z.string().min(1),
    WA_ACCESS_TOKEN: z.string().optional().default(''),
    WA_PHONE_NUMBER_ID: z.string().optional().default(''),
    WA_GRAPH_VERSION: z.string().default('v21.0'),

    LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'), // 'openai' = any OpenAI-compatible API (Groq, OpenAI, Gemini, vLLM)
    OPENAI_API_KEY: z.string().optional().default(''),
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
    ANTHROPIC_API_KEY: z.string().optional().default(''),
    ANTHROPIC_BASE_URL: z.string().url().optional(), // in-country endpoint when required (§10.4)
    LLM_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
    LLM_MODEL_SMART: z.string().default('claude-sonnet-5-5'),
    LLM_DAILY_TOKEN_BUDGET_PER_FACILITY: z.coerce.number().int().positive().default(2_000_000),
    LLM_ALLOW_OFFSHORE_PATIENT_CONTEXT: z.coerce.boolean().default(false), // §20 open decision 1

    EMBEDDINGS_PROVIDER: z.enum(['mock', 'http', 'voyage']).default('mock'),
    EMBEDDINGS_API_KEY: z.string().optional().default(''),
    EMBEDDINGS_BASE_URL: z.string().optional().default(''),
    EMBEDDINGS_MODEL: z.string().default('mock-1024'),
    EMBEDDINGS_DIM: z.coerce.number().int().default(1024),

    ASR_PROVIDER: z.enum(['none', 'bhashini']).default('none'),
    ASR_API_KEY: z.string().optional().default(''),
    SMS_PROVIDER: z.enum(['log', 'http']).default('log'),
    SMS_API_URL: z.string().optional().default(''),
    SMS_API_KEY: z.string().optional().default(''),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default(''),
    PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && !v.KMS_KEY_ID) {
      ctx.addIssue({ code: 'custom', path: ['KMS_KEY_ID'], message: 'KMS_KEY_ID is required in production' });
    }
    if (v.NODE_ENV !== 'production' && !v.DEV_MASTER_KEY && !v.KMS_KEY_ID) {
      ctx.addIssue({ code: 'custom', path: ['DEV_MASTER_KEY'], message: 'DEV_MASTER_KEY (or KMS_KEY_ID) is required' });
    }
    if (v.NODE_ENV === 'production' && v.EMBEDDINGS_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['EMBEDDINGS_PROVIDER'], message: 'mock embeddings are not allowed in production' });
    }
  });

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid environment configuration:\n${lines}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
