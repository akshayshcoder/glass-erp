import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * Which proxies to believe about the client's IP (X-Forwarded-For). The IP is
   * used for rate limiting and the audit log, so never trust every hop:
   *   false (default)   no proxy in front: use the socket address
   *   1                 exactly one proxy (nginx/Caddy on the same machine)
   *   127.0.0.1,10.0.0.5  only these proxy addresses
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v): boolean | number | string[] =>
      v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v.split(',').map((s) => s.trim()),
    ),
  /** Send the login cookie over HTTPS only. Defaults to true in production. */
  COOKIE_SECURE: flag.optional(),
  /** Requests per minute per IP, for everything / for sign-in and sign-up. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** The built web app (web/dist). When set, the API serves it on the same origin. */
  WEB_DIST_DIR: z.string().optional(),
});

export type Config = Omit<z.infer<typeof EnvSchema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

/** Reads and validates configuration once at startup; fails fast on bad values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const c = result.data;
  return { ...c, COOKIE_SECURE: c.COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}
