import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { AppError } from './errors.js';

/**
 * Browser and abuse protection, in one place:
 *
 *   * Security headers (helmet) with a strict Content-Security-Policy: the web
 *     app may only load its own scripts and talk to its own origin, so injected
 *     markup can't pull in or send data to anything else.
 *   * Rate limits per client IP: a generous one for everything, a tight one for
 *     sign-in / sign-up (routes opt in with `config: { rateLimit: authRateLimit(config) }`).
 *     Per-account lockout after failed passwords is separate (auth.service.ts).
 *   * Cookies, for the refresh token (see auth/session-cookie.ts).
 *
 * Limits are counted in this process's memory. Running several API processes
 * behind a load balancer needs a shared store (Redis); see docs/03-operations.md.
 */
export async function registerSecurity(app: FastifyInstance, config: Config) {
  await app.register(cookie);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        // PDFs are opened from blob: URLs, which inherit this policy.
        objectSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        ...(config.COOKIE_SECURE && { upgradeInsecureRequests: [] }),
      },
    },
    // Tell browsers "HTTPS only" just when we really are served over HTTPS.
    strictTransportSecurity: config.COOKIE_SECURE
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
    errorResponseBuilder: (_request, context) =>
      new AppError(
        429,
        'RATE_LIMITED',
        `Too many requests. Please wait ${context.after} and try again.`,
      ),
  });
}

/** Tight limit for the sign-in and sign-up endpoints (password guessing, spam accounts). */
export const authRateLimit = (config: Config) => ({
  max: config.AUTH_RATE_LIMIT_PER_MINUTE,
  timeWindow: '1 minute',
});
