import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../http/errors.js';

const ISSUER = 'glass-erp';
const AUDIENCE = 'glass-erp-api';

export interface AccessTokenClaims {
  userId: string;
  /** Session family id: checked against erp.user_sessions on every request. */
  sessionId: string;
}

/** Short-lived, signed access tokens (JWT, HS256). */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    readonly accessTokenTtlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  createAccessToken({ userId, sessionId }: AccessTokenClaims): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + this.accessTokenTtlSeconds)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('missing claims');
      }
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired access token');
    }
  }
}

/** Long-lived refresh token: random, opaque, stored only as a hash. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
