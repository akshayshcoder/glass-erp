# 0005: Short access tokens, rotating refresh tokens, session check per request

**Status:** accepted

## Context

Shop counters are shared PCs; staff leave; phones get lost. Removing someone's access must take effect
immediately, not when a long-lived token expires.

## Decision

- **Access token**: JWT (HS256), 15 minutes, carries user id + session family id.
- **Refresh token**: 32 random bytes, stored only as a SHA-256 hash in `erp.user_sessions`, 30 days.
- Every refresh **rotates**: the old token is revoked atomically (exactly one of two parallel refreshes wins).
- Re-use of a token rotated more than 10 seconds ago means it was stolen: the whole login (family) is revoked.
- Every request checks in one query that the user is active, the session is not revoked and, if a shop is selected,
  that the user is still an active member of an active shop.
- Passwords: Argon2id (OWASP parameters). Accounts lock for 15 minutes after 5 wrong passwords (atomic counter).
  Unknown users and wrong passwords get the same response and similar timing.

## Consequences

- \+ Logout, disabling a user, or removing them from a shop works on their very next request.
- − One small extra query per request (indexed). Can be cached briefly later if needed.
- Still to add before production: per-IP rate limiting on `/auth/*`, CORS and security headers (with the web app).
