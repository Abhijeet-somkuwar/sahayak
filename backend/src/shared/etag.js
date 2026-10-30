import { AppError } from './errors.js';

export function setEtag(reply, version) {
  reply.header('etag', `"${version}"`);
}

/** If-Match is mandatory on this route. */
export function requireVersion(req) {
  const v = expectedVersion(req, false);
  if (v === undefined) throw new AppError('version_conflict', 'If-Match header is required', undefined, 428);
  return v;
}

/** Parses If-Match into the expected version. Required unless `optional` is set. */
export function expectedVersion(req, optional = false) {
  const raw = req.headers['if-match'];
  if (!raw) {
    if (optional) return undefined;
    throw new AppError('version_conflict', 'If-Match header with the current ETag is required', undefined, 428);
  }
  const m = String(raw).match(/"?(\d+)"?/);
  if (!m) throw AppError.validation('If-Match must be a version ETag like "3"');
  return parseInt(m[1], 10);
}
