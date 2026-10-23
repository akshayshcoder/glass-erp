import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, '..');
const rootDir = resolve(webDir, '..');

rmSync(resolve(webDir, 'api/_dist'), { recursive: true, force: true });

await esbuild.build({
  entryPoints: [resolve(webDir, 'api/_entry.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: resolve(webDir, 'api/_bundle.cjs'),
  external: ['@node-rs/argon2', 'pg-native'],
  alias: {
    pdfkit: resolve(rootDir, 'node_modules/pdfkit/js/pdfkit.standalone.js'),
  },
  logLevel: 'info',
});
