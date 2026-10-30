/**
 * AppError → RFC 9457 problem+json, mapped in one place (§11.1, §17.8).
 */
export const ErrorCodes = {
  validation_failed: 400,
  bad_request: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  mfa_required: 401,
  token_revoked: 401,
  forbidden: 403,
  care_relationship_required: 403,
  consent_required: 403,
  facility_scope_violation: 403,
  not_found: 404,
  conflict: 409,
  queue_unavailable: 409,
  possible_duplicates: 409,
  invalid_state: 409,
  session_closed: 409,
  version_conflict: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 422,
  idempotency_key_required: 422,
  account_locked: 423,
  rate_limited: 429,
  internal_error: 500,
  audit_write_failed: 500,
  service_unavailable: 503,
  database_unavailable: 503,
};

export class AppError extends Error {
  code;
  status;
  detail;
  extra;

  constructor(code, detail, extra, status) {
    super(detail ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ErrorCodes[code];
    this.detail = detail;
    this.extra = extra;
  }

  static notFound(what) {
    return new AppError('not_found', `${what} not found`);
  }
  static forbidden(detail = 'forbidden') {
    return new AppError('forbidden', detail);
  }
  static conflict(detail) {
    return new AppError('conflict', detail);
  }
  static versionConflict() {
    return new AppError('version_conflict', 'the resource was modified by someone else; reload and retry');
  }
  static validation(detail, errors) {
    return new AppError('validation_failed', detail, errors ? { errors } : undefined);
  }
}

const titles = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function toProblem(err, requestId) {
  const p = {
    type: `https://sahayak.health/errors/${err.code}`,
    title: titles[err.status] ?? 'Error',
    status: err.status,
    code: err.code,
  };
  if (err.detail) p.detail = err.detail;
  if (requestId) p.request_id = requestId;
  if (err.extra) Object.assign(p, err.extra);
  return p;
}
