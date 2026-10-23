# 0006: Where the web app keeps login tokens

**Status:** accepted. Revised in step 6: the refresh token moved from `localStorage` to an httpOnly cookie.

## Context

The API issues a short-lived access token (15 min) and a long-lived refresh token (30 days, rotating, reuse
detection, see ADR 0005). The browser must keep the user signed in across page reloads, without letting an
injected script steal a token that stays valid for a month.

## Decision

- The **access token** lives only in memory (a JavaScript variable). A reload loses it and it is silently
  re-obtained.
- The **refresh token** is an `httpOnly; SameSite=Strict` cookie scoped to `/v1/auth` (`Secure` in
  production). JavaScript can't read it. `localStorage` only holds a "signed in" flag, which is not a secret.
- Browsers opt in with the header `X-Session-Transport: cookie`; the API reads the cookie only when that header
  is present. A cross-site page can't send custom headers without a CORS preflight (which the API never
  approves), so together with `SameSite=Strict` this rules out CSRF on the refresh endpoint. Other clients
  (scripts, a future mobile app) leave the header out and get the refresh token in the JSON body as before.
- A strict **Content-Security-Policy** (`script-src 'self'`, `connect-src 'self'`, no inline scripts or
  styles, `frame-ancestors 'none'`) limits what injected markup could do at all.
- The web app and API are served from **one origin** (dev: Vite proxy; prod: the API serves `web/dist`, or a
  reverse proxy), so no CORS is needed.
- Users signed in before this change had the token in `localStorage`: the app sends it once to
  `/auth/refresh`, receives the cookie and deletes the stored copy.

## Consequences

- \+ An XSS bug can no longer exfiltrate a long-lived login; at worst it acts within the open tab.
- \+ The e2e journey asserts that no token is readable by page scripts and that the CSP blocks nothing in the
  app itself.
- − Cookies tie the session to one site name; serving the app and API from different domains would need CORS
  with credentials and a revisit of this ADR.
