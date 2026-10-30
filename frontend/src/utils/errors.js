// Error types thrown by the Axios layer, and the mapping to user-facing message keys (§7.3).
export class ApiError extends Error {
  constructor(problem) {
    super(problem.detail || problem.code);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail;
    this.requestId = problem.requestId;
    this.errors = problem.errors;
    this.extra = problem;
  }
}

export class NetworkError extends Error {
  constructor(message = 'network') {
    super(message);
    this.name = 'NetworkError';
  }
}

export function describeError(e) {
  if (e instanceof NetworkError) return { key: 'err.network' };
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'queue_unavailable':
        return { key: 'err.queue_unavailable' };
      case 'version_conflict':
        return { key: 'err.version_conflict' };
      case 'rate_limited':
        return { key: 'err.rate_limited', params: { minutes: Math.max(1, Math.ceil((e.extra.retryAfter || 60) / 60)) } };
      case 'unauthorized':
        return { key: 'err.unauthorized' };
      case 'invalid_credentials': // wrong password, or a wrong / expired authenticator code
        return { key: 'err.invalidCredentials' };
      case 'account_locked':
        return { key: 'err.accountLocked' };
      case 'validation_failed':
        return { key: 'err.validation' };
      case 'not_found':
        return { key: 'err.notFound' };
      default:
        return { key: 'err.generic', params: { requestId: e.requestId || '—' } };
    }
  }
  return { key: 'err.generic', params: { requestId: '—' } };
}
