/**
 * UUIDv7 ids (D3). Never use crypto.randomUUID() (v4) for database ids.
 * uuid7Boundary mirrors the SQL function of the same name (migration 0001, §6.3).
 */
import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

export function newId() {
  return uuidv7();
}

/** Smallest UUIDv7 that can be generated at or after `at`: 48-bit ms timestamp followed by zero bits. */
export function uuid7Boundary(at) {
  const ms = typeof at === 'number' ? at : at.getTime();
  const hex = Math.floor(ms).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/** Boundary for "now minus N months" — the standard bound for non-key lookups on partitioned tables. */
export function boundaryMonthsAgo(months, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return uuid7Boundary(d);
}

export function boundaryDaysAgo(days, now = new Date()) {
  return uuid7Boundary(now.getTime() - days * 86_400_000);
}

export function isUuid(v) {
  return typeof v === 'string' && uuidValidate(v);
}

/** Extract the millisecond timestamp embedded in a UUIDv7. */
export function uuid7Time(id) {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(parseInt(hex, 16));
}
