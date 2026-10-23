import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

async function main() {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_SIZE,
    onError: (err) => console.error('idle database client error', err),
  });
  const app = await buildApp({ config, pool });

  // Graceful shutdown: stop accepting requests, let in-flight ones finish, then
  // close database connections.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
