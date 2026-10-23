import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * Error codes returned to clients. Stable: the web/mobile apps switch on these,
 * never on the human-readable message.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'SESSION_REVOKED'
  | 'FORBIDDEN'
  | 'TENANT_REQUIRED'
  | 'NOT_A_MEMBER'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'VERSION_CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'INVALID_STATE'
  | 'RECORD_LOCKED'
  | 'GST_PERIOD_LOCKED'
  | 'BUSINESS_RULE'
  | 'INVALID_REFERENCE'
  | 'TRY_AGAIN'
  | 'RATE_LIMITED'
  | 'INTERNAL';

/** An expected, client-facing error. Throw it from services and routes. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'FORBIDDEN', message);
export const versionConflict = () =>
  new AppError(
    409,
    'VERSION_CONFLICT',
    'This record was changed by someone else. Reload and try again.',
  );

/**
 * SQLSTATE -> HTTP. ERPxx codes are raised by our own database functions
 * (see docs/01-architecture.md, section 9) and carry safe, readable messages.
 */
const SQLSTATE_MAP: Record<string, [number, ErrorCode]> = {
  ERP01: [409, 'INSUFFICIENT_STOCK'],
  ERP02: [409, 'INVALID_STATE'],
  ERP03: [409, 'RECORD_LOCKED'],
  ERP04: [422, 'BUSINESS_RULE'],
  ERP05: [409, 'GST_PERIOD_LOCKED'],
  '42501': [403, 'FORBIDDEN'],
  '23505': [409, 'DUPLICATE'],
  '23514': [422, 'BUSINESS_RULE'],
  '23503': [422, 'INVALID_REFERENCE'],
  '22P02': [400, 'VALIDATION_FAILED'],
  '40001': [503, 'TRY_AGAIN'],
  '40P01': [503, 'TRY_AGAIN'],
};

interface PgError {
  code: string;
  message: string;
  detail?: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgError {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

interface Problem {
  status: number;
  code: ErrorCode;
  title: string;
  detail?: unknown;
}

function toProblem(err: unknown): Problem {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, title: err.message, detail: err.details };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Some fields are invalid',
      detail: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    };
  }
  if (isPgError(err) && SQLSTATE_MAP[err.code]) {
    const [status, code] = SQLSTATE_MAP[err.code]!;
    const ownMessage = err.code.startsWith('ERP') || err.code === '42501';
    return {
      status,
      code,
      title: ownMessage ? err.message : defaultTitle(code),
      detail: err.code.startsWith('ERP') ? err.detail : err.constraint,
    };
  }
  const fastifyErr = err as Partial<FastifyError>;
  if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    return {
      status: fastifyErr.statusCode,
      code: 'VALIDATION_FAILED',
      title: fastifyErr.message ?? 'Bad request',
    };
  }
  return { status: 500, code: 'INTERNAL', title: 'Something went wrong. Please try again.' };
}

function defaultTitle(code: ErrorCode): string {
  switch (code) {
    case 'DUPLICATE':
      return 'A record with these details already exists';
    case 'INVALID_REFERENCE':
      return 'A referenced record does not exist';
    case 'TRY_AGAIN':
      return 'The system is busy. Please try again.';
    case 'VALIDATION_FAILED':
      return 'Some fields are invalid';
    default:
      return 'The request breaks a business rule';
  }
}

/** Fastify error handler: every error becomes an RFC 9457 problem document. */
export function errorHandler(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const problem = toProblem(err);
  if (problem.status >= 500) {
    request.log.error({ err }, 'request failed');
  } else {
    request.log.info({ code: problem.code, status: problem.status }, problem.title);
  }
  return reply
    .status(problem.status)
    .type('application/problem+json')
    .send({
      type: 'about:blank',
      status: problem.status,
      code: problem.code,
      title: problem.title,
      ...(problem.detail !== undefined && { detail: problem.detail }),
      requestId: request.id,
    });
}
