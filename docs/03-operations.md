# Operations: running Glass ERP for real

How to run the product outside development, and what to check before real shops use it.

## 1. Production mode: one process, one port

The API can serve the built web app itself, so production is a single Node process (plus PostgreSQL):

```bash
npm ci
npm run build -w web             # -> web/dist
npm run build -w api             # -> api/dist
cd api
NODE_ENV=production WEB_DIST_DIR=../web/dist npm start
```

`npm start` reads `api/.env` (see [api/.env.example](../api/.env.example)). Open `http://<server>:4000`: the
pages, then the API under `/v1`, all on one origin. Security headers and the Content-Security-Policy cover both.

Put **HTTPS** in front (Caddy or nginx on the same machine). Then set:

| Variable                     | Value behind a local HTTPS proxy | Why                                                                    |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                   | `production`                     | Turns on `Secure` cookies and HSTS                                     |
| `HOST`                       | `127.0.0.1`                      | Only the proxy can reach Node; the world talks to the proxy            |
| `TRUST_PROXY`                | `1`                              | Believe exactly one proxy hop for the client IP (rate limits, audit)   |
| `WEB_DIST_DIR`               | `../web/dist`                    | Serve the app                                                          |
| `JWT_SECRET`                 | 48+ random characters            | Changing it signs everyone out (access tokens only live 15 minutes)    |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `10` (default)                   | Sign-in/sign-up attempts per IP per minute. A shop behind one router … |
| `RATE_LIMIT_PER_MINUTE`      | `600` (default)                  | … shares one IP, so keep these generous enough for a busy counter      |

Never set `TRUST_PROXY=true` (trust every hop): anyone could then fake their IP with an `X-Forwarded-For`
header to dodge rate limits and falsify the audit log.

## 2. Security built into the app (step 6a)

| Threat                       | Protection                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Password guessing            | 10 sign-in attempts / minute / IP; account locks for 15 minutes after 5 wrong passwords       |
| Stolen login token (XSS)     | Refresh token in an `httpOnly` cookie; strict CSP (`script-src 'self'`); see ADR 0006         |
| Replayed refresh token       | Rotation with reuse detection ends the whole login (ADR 0005)                                 |
| CSRF on the refresh endpoint | `SameSite=Strict` cookie + required `X-Session-Transport` header                              |
| Clickjacking                 | `frame-ancestors 'none'`, `X-Frame-Options`                                                   |
| Flooding                     | 600 requests / minute / IP; 1 MB request body limit                                           |
| Cross-shop data leaks        | PostgreSQL row-level security on every table (ADR 0002), checked per request                  |
| Tampering with history       | Posted documents are immutable; every change is in `audit.row_changes` with user, IP, request |

Limits are counted in the API process's memory. That is right for one server. When you run several API
processes behind a load balancer, move the counters to Redis (`@fastify/rate-limit` supports it).

## 3. Before the first real shop: checklist

- [ ] **Database server:** change the `postgres` superuser password; allow port 5432 only from the API server
      (firewall), never from the whole internet; require SSL for remote connections.
- [ ] The API connects as its own login role (`erp_api`, member of `erp_app`), **never** as `postgres` or
      `erp_owner`, otherwise row-level security is bypassed.
- [ ] `api/.env` has a fresh `JWT_SECRET` and is readable only by the service user.
- [ ] HTTPS in front, `NODE_ENV=production`, `HOST=127.0.0.1`, `TRUST_PROXY=1`.
- [ ] Backups run daily and a restore has been tested (step 6b).
- [ ] Uptime monitoring calls `/readyz` (step 6b).

## 4. Health checks

| URL        | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `/healthz` | The process is up                                          |
| `/readyz`  | It can reach the database (use this for uptime monitoring) |

Neither counts towards rate limits. Every response carries `X-Request-Id`; quote it when reporting a problem,
and find the matching log lines and audit rows with it.
