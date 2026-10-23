import { buildApp } from '../../api/src/app.ts';
import { loadConfig } from '../../api/src/config.ts';
import { createPool } from '../../api/src/db/pool.ts';


let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const rawDbUrl = (process.env.DATABASE_URL || '').trim();
      if (!rawDbUrl) throw new Error('DATABASE_URL environment variable is not set');
      const cleanDbUrl = rawDbUrl.replace(/([?&])channel_binding=require(&?)/, (_, p1, p2) =>
        p2 ? p1 : '',
      );
      const rawJwt = (process.env.JWT_SECRET || '').trim();
      if (rawJwt.length < 32) throw new Error('JWT_SECRET must be set (min 32 chars)');
      const jwtSecret = rawJwt;

      const cfg = loadConfig({
        ...process.env,
        DATABASE_URL: cleanDbUrl,
        JWT_SECRET: jwtSecret,
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        TRUST_PROXY: process.env.TRUST_PROXY ?? '1',
        DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE ?? '3',
      });
      const pool = createPool({
        connectionString: cfg.DATABASE_URL,
        max: cfg.DATABASE_POOL_SIZE,
        onError: (err) => console.error('idle database client error', err),
      });
      const app = await buildApp({ config: cfg, pool });
      await app.ready();
      return app;
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export async function handleRequest(req, res) {
  const app = await getApp();
  await new Promise((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    app.server.emit('request', req, res);
  });
}
