import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const assetsDir = path.join(repoRoot, 'assets');
const nmDir = process.env.GCODE_VENDOR_NM
  ? path.resolve(process.env.GCODE_VENDOR_NM)
  : path.join(here, 'node_modules');

const require = createRequire(import.meta.url);
const esbuild = require(path.join(nmDir, 'esbuild'));

const BANNER =
  '/* Bundled @chestnutlabs/gcode-preview-element@0.24.0 + three@0.178.0 (MIT). ' +
  'See docs/third-party-licenses-gcode.md. Offline self-hosted bundle. */';

// Rewrite internal relative worker URLs to match /assets/vendor-gcode-*.js (classic IIFE workers, CSP 'self').
const workerUrlPlugin = {
  name: 'rewrite-worker-urls',
  setup(build) {
    build.onLoad({ filter: /geometry-pool\.js$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = contents.replace(
        /new Worker\(\s*new URL\(['"]\.\/geometry-worker\.js['"],\s*import\.meta\.url\)\s*,\s*\{\s*type:\s*['"]module['"]\s*\}\s*\)/g,
        "new Worker(new URL('./vendor-gcode-geo-worker.js', import.meta.url))"
      );
      return { contents, loader: 'js' };
    });
    build.onLoad({ filter: /gcode-parser[\\/]dist[\\/]session\.js$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = contents.replace(
        /new Worker\(\s*new URL\(['"]\.\/worker\.js['"],\s*import\.meta\.url\)\s*,\s*\{\s*type:\s*['"]module['"]\s*\}\s*\)/g,
        "new Worker(new URL('./vendor-gcode-worker.js', import.meta.url))"
      );
      return { contents, loader: 'js' };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, 'entry-viewer.mjs')],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  nodePaths: [nmDir],
  plugins: [workerUrlPlugin],
  banner: { js: BANNER },
  outfile: path.join(assetsDir, 'vendor-gcode-preview.mjs'),
});

await esbuild.build({
  entryPoints: [path.join(here, 'entry-parse-worker.mjs')],
  bundle: true,
  format: 'iife',
  minify: true,
  sourcemap: false,
  nodePaths: [nmDir],
  banner: { js: BANNER },
  outfile: path.join(assetsDir, 'vendor-gcode-worker.js'),
});

await esbuild.build({
  entryPoints: [path.join(nmDir, '@chestnutlabs', 'gcode-renderer-three', 'dist', 'geometry-worker.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  sourcemap: false,
  nodePaths: [nmDir],
  banner: { js: BANNER },
  outfile: path.join(assetsDir, 'vendor-gcode-geo-worker.js'),
});

console.log('Built vendor-gcode-preview.mjs, vendor-gcode-worker.js, vendor-gcode-geo-worker.js');
