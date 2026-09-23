/**
 * Typed application errors. `status` maps to HTTP status in the API layer; `code` is a stable
 * machine-readable identifier. Messages must never contain secrets.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; code?: string; details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.status = opts.status ?? 500;
    this.code = opts.code ?? 'INTERNAL_ERROR';
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', details?: unknown) {
    super(message, { status: 403, code: 'FORBIDDEN', details });
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(id ? `${entity} ${id} not found` : `${entity} not found`, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 409, code: 'CONFLICT', details });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message = 'Rate limit exceeded') {
    super(message, { status: 429, code: 'RATE_LIMITED', retryable: true });
    this.retryAfterSec = retryAfterSec;
  }
}

/** A policy forbids this action outright (e.g. READ_ONLY mode, or tool not granted to agent). */
export class PolicyDeniedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 403, code: 'POLICY_DENIED', details });
  }
}

/** The action needs a human decision; an approval request has been (or must be) created. */
export class ApprovalRequiredError extends AppError {
  readonly approvalId: string;
  constructor(approvalId: string, message = 'Human approval required before this action can run') {
    super(message, { status: 202, code: 'APPROVAL_REQUIRED', details: { approvalId } });
    this.approvalId = approvalId;
  }
}

export class BudgetExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 402, code: 'BUDGET_EXCEEDED', details });
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'Operation timed out') {
    super(message, { status: 504, code: 'TIMEOUT', retryable: true });
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, opts: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, { status: 502, code: 'EXTERNAL_SERVICE_ERROR', retryable: opts.retryable ?? true, details: opts.details, cause: opts.cause });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
