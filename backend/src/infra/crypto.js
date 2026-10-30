/**
 * Envelope encryption and blind indexes (D14, §13.2).
 * Ciphertext format: version(1) | key_version(2) | nonce(12) | ciphertext | tag(16).
 * Data keys per purpose ('pii', 'cache', 'jobs') are unwrapped at startup and held only in memory.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const FORMAT_VERSION = 1;
const CURRENT_KEY_VERSION = 1;

/** Dev/test provider: derives per-purpose data keys from DEV_MASTER_KEY with HKDF. */
export class LocalKeyProvider {
  cache = new Map();
  constructor(master) {
    this.master = master;
    if (master.length !== 32) throw new Error('master key must be 32 bytes');
  }
  dataKey(purpose, version) {
    const k = `${purpose}:${version}`;
    let key = this.cache.get(k);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.master, Buffer.from(purpose), Buffer.from(`sahayak-data-key-v${version}`), 32));
      this.cache.set(k, key);
    }
    return key;
  }
  currentVersion() {
    return CURRENT_KEY_VERSION;
  }
}

/**
 * Production provider: data keys wrapped by a KEK held in an in-country KMS/HSM (§13.2).
 * The unwrap call is infrastructure-specific; this adapter expects the unwrapped keys to be injected
 * by the KMS integration at boot (see docs/DECISIONS.md, open decision 4 — hosting).
 */
export class KmsKeyProvider {
  constructor(unwrapped, versions) {
    this.unwrapped = unwrapped;
    this.versions = versions;
  }
  dataKey(purpose, version) {
    const key = this.unwrapped.get(`${purpose}:${version}`);
    if (!key) throw new Error(`data key ${purpose} v${version} is not available`);
    return key;
  }
  currentVersion(purpose) {
    return this.versions[purpose];
  }
}

function buildProvider() {
  if (env.DEV_MASTER_KEY) return new LocalKeyProvider(Buffer.from(env.DEV_MASTER_KEY, 'base64'));
  throw new Error('No key provider configured: set DEV_MASTER_KEY (dev) or wire the KMS adapter (prod)');
}

let provider;
function keys() {
  return (provider ??= buildProvider());
}
/** For tests and the KMS boot sequence. */
export function setKeyProvider(p) {
  provider = p;
}

export function encrypt(purpose, plaintext) {
  const kv = keys().currentVersion(purpose);
  const key = keys().dataKey(purpose, kv);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.alloc(3);
  header.writeUInt8(FORMAT_VERSION, 0);
  header.writeUInt16BE(kv, 1);
  return { ciphertext: Buffer.concat([header, nonce, ct, tag]), keyVersion: kv };
}

export function decrypt(purpose, blob) {
  if (blob.length < 3 + 12 + 16) throw new Error('ciphertext too short');
  const version = blob.readUInt8(0);
  if (version !== FORMAT_VERSION) throw new Error(`unsupported ciphertext version ${version}`);
  const kv = blob.readUInt16BE(1);
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(15, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', keys().dataKey(purpose, kv), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptJson(purpose, value) {
  return encrypt(purpose, JSON.stringify(value));
}
export function decryptJson(purpose, blob) {
  return JSON.parse(decrypt(purpose, blob).toString('utf8'));
}
export function decryptText(purpose, blob) {
  return decrypt(purpose, blob).toString('utf8');
}

// ---- Blind indexes (§9.2): HMAC-SHA256(K_blind, "<kind>:" + normalised) with a key separate from the data keys.
const blindKey = Buffer.from(env.BLIND_INDEX_KEY, 'base64');

export function blindIndex(kind, normalised) {
  return createHmac('sha256', blindKey).update(`${kind}:${normalised}`).digest();
}

export function sha256(data) {
  return createHash('sha256').update(data).digest();
}
export function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}
export function hmacSha256Hex(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function safeEqual(a, b) {
  const ab = typeof a === 'string' ? Buffer.from(a) : a;
  const bb = typeof b === 'string' ? Buffer.from(b) : b;
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** Random base32 string, e.g. the 10-character public token reference (§9.1). */
export function randomBase32(length = 10) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE32[bytes[i] % 32];
  return out;
}

export function randomDigits(n = 6) {
  const max = 10 ** n;
  const v = randomBytes(4).readUInt32BE(0) % max;
  return v.toString().padStart(n, '0');
}
