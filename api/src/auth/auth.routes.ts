import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app-context.js';
import type { RequestContext } from '../db/transaction.js';
import { AppError } from '../http/errors.js';
import { userOf } from '../http/request.js';
import { authRateLimit } from '../http/security.js';
import { LoginBody, RefreshBody, RegisterBody } from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { clearRefreshCookie, refreshTokenFromCookie, sendTokens } from './session-cookie.js';

/**
 *   POST /v1/auth/register   create a user account
 *   POST /v1/auth/login      -> access + refresh token
 *   POST /v1/auth/refresh    rotate the refresh token
 *   POST /v1/auth/logout     end this login on this device
 *   GET  /v1/me              profile + the shops the user belongs to
 *
 * Browsers send `X-Session-Transport: cookie` and get the refresh token as an
 * httpOnly cookie instead of in the body (see session-cookie.ts).
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, tokens, config, guards } = ctx;
  const auth = new AuthService(pool, tokens, config.REFRESH_TOKEN_TTL_DAYS);
  const strict = { config: { rateLimit: authRateLimit(config) } };
  const contextOf = (r: FastifyRequest): RequestContext => ({
    requestId: r.id,
    clientIp: r.ip,
    userId: r.auth?.userId ?? null,
  });

  app.post('/auth/register', strict, async (request, reply) => {
    const user = await auth.register(contextOf(request), RegisterBody.parse(request.body));
    return reply.status(201).send(user);
  });

  app.post('/auth/login', strict, async (request, reply) => {
    const pair = await auth.login(
      contextOf(request),
      LoginBody.parse(request.body),
      request.headers['user-agent'],
    );
    return sendTokens(request, reply, config, pair);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const token = RefreshBody.parse(request.body)?.refreshToken ?? refreshTokenFromCookie(request);
    try {
      if (!token) {
        throw new AppError(401, 'SESSION_REVOKED', 'Your session has ended. Please sign in again.');
      }
      const pair = await auth.refresh(contextOf(request), token, request.headers['user-agent']);
      return sendTokens(request, reply, config, pair);
    } catch (err) {
      clearRefreshCookie(reply, config);
      throw err;
    }
  });

  app.post('/auth/logout', { preHandler: guards.user }, async (request, reply) => {
    await auth.logout(contextOf(request), userOf(request).sessionId);
    clearRefreshCookie(reply, config);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: guards.user }, async (request) => auth.me(contextOf(request)));
}
