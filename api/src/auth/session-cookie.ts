import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { TokenPair } from './auth.service.js';

/*
 * Browsers keep the refresh token in a cookie JavaScript cannot read
 * (docs/adr/0006). Other clients (scripts, a future mobile app) keep getting it
 * in the JSON body as before.
 *
 * A client asks for cookie mode with the header `X-Session-Transport: cookie`.
 * The cookie is only ever READ when that header is present too: a plain
 * cross-site form or link can't set custom headers, so on top of
 * SameSite=Strict this blocks login-CSRF style tricks.
 */

const COOKIE = 'erp_refresh';
const PATH = '/v1/auth';

export const wantsCookie = (request: FastifyRequest) =>
  request.headers['x-session-transport'] === 'cookie';

/** The refresh token from the cookie, in cookie mode only. */
export function refreshTokenFromCookie(request: FastifyRequest): string | undefined {
  return wantsCookie(request) ? request.cookies[COOKIE] : undefined;
}

/**
 * Sends a token pair. In cookie mode the refresh token goes into the cookie and
 * is left out of the body.
 */
export function sendTokens(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  pair: TokenPair,
) {
  if (!wantsCookie(request)) return pair;
  const { refreshToken, ...rest } = pair;
  reply.setCookie(COOKIE, refreshToken, {
    path: PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
  return rest;
}

export function clearRefreshCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(COOKIE, {
    path: PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
  });
}
