import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built web app (web/dist) from the API's own origin, so one process
 * on one port is the whole product: no CORS, and the security headers and
 * Content-Security-Policy cover the pages too.
 *
 *   /assets/*   fingerprinted files: cached for a year
 *   other GETs  index.html (the app's router decides), never cached
 *   /v1/*       the API, unaffected
 */
export async function serveWebApp(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  if (!existsSync(resolve(root, 'index.html'))) {
    throw new Error(`WEB_DIST_DIR=${dir}: no index.html there. Run "npm run build -w web" first.`);
  }

  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    setHeaders(res, path) {
      res.header(
        'cache-control',
        /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
}

/** For a browser GET to an app URL (not the API): the app's index.html. */
export function isAppPage(method: string, url: string, accept: string | undefined) {
  return (
    (method === 'GET' || method === 'HEAD') &&
    !url.startsWith('/v1/') &&
    !/\.[a-z0-9]+$/i.test(url.split('?')[0]!) &&
    (accept ?? '').includes('text/html')
  );
}
