export class NotFoundError extends Error { override name = 'NotFoundError'; }
export class WagerNotFoundError extends NotFoundError { override name = 'WagerNotFoundError'; }
export class ConflictError extends Error { override name = 'ConflictError'; }
export class RetryExhaustedError extends Error { override name = 'RetryExhaustedError'; }
export class PersistenceInvariantError extends Error { override name = 'PersistenceInvariantError'; }

export function sqlError(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const data = current as Record<string, unknown>;
    if (typeof data['code'] === 'string') return { code: data['code'], ...(typeof data['constraint'] === 'string' ? { constraint: data['constraint'] } : {}) };
    current = data['cause'] ?? data['previous'] ?? data['originalError'];
  }
  return {};
}
