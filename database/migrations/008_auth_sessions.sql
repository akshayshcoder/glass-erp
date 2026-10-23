-- =============================================================================
-- 008_auth_sessions.sql
-- Login sessions (refresh tokens).
--
--   * Only a SHA-256 hash of the refresh token is stored: a database leak does
--     not leak usable tokens.
--   * Every refresh ROTATES the token (old row revoked, new row created).
--     All rotations of one login share a family_id.
--   * Re-using an already-rotated token means it was stolen: the whole family
--     (that login on every device) is revoked.
--   * Access tokens carry the family_id and the API checks it on every request,
--     so logout / disabling a user takes effect immediately.
-- Sessions belong to a user, not to a shop, so there is no tenant_id / RLS.
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

CREATE TABLE erp.user_sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid        NOT NULL,
  user_id            uuid        NOT NULL REFERENCES erp.users (id),
  refresh_token_hash text        NOT NULL UNIQUE CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text        CHECK (revoked_reason IN ('rotated', 'logout', 'reuse_detected', 'user_disabled')),
  user_agent         text,
  client_ip          inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX user_sessions_family_idx ON erp.user_sessions (family_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_user_idx   ON erp.user_sessions (user_id);

RESET ROLE;
