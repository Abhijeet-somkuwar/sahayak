import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client;

function s3() {
  if (!client) {
    client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: !!env.S3_ENDPOINT,
      credentials:
        env.S3_ACCESS_KEY && env.S3_SECRET_KEY ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined,
    });
  }
  return client;
}

export async function ensureBucket() {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    try {
      await s3().send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
      logger.info({ bucket: env.S3_BUCKET }, 'created object storage bucket');
    } catch (err) {
      logger.warn({ err }, 'could not ensure bucket; object storage may be unavailable');
    }
  }
}

export async function putObject(key, body, contentType, metadata) {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
      ServerSideEncryption: 'AES256',
    }),
  );
  return key;
}

export async function getObject(key) {
  const res = await s3().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  return Buffer.from(bytes ?? new Uint8Array());
}

export async function deleteObject(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/** Storage paths are built from ids, never from user-supplied names. */
export const storageKeys = {
  kbDocument: (facilityId, docId, ext) => `kb/${facilityId ?? 'state'}/${docId}.${ext}`,
  patientDocument: (patientId, docId, ext) => `patient-docs/${patientId}/${docId}.${ext}`,
  media: (conversationId, messageId, ext) => `media/${conversationId}/${messageId}.${ext}`,
  auditExport: (periodStart) => `audit/${periodStart.slice(0, 10)}/${periodStart}.jsonl.gz`,
  partitionArchive: (table, partition) => `archive/${table}/${partition}.csv.gz`,
};
