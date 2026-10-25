import { rmSync } from 'node:fs';

import { build } from 'esbuild';

// ONE self-contained file, dist/mail.mjs, holding the source and every dependency, which mail/compose.yaml runs on
// node:22-alpine: no node_modules, no npm on the VM. `node deploy.mjs vm` runs this before sending mail/.

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.mjs'],
  outfile: 'dist/mail.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: true,
  // ESM output: recreate the CommonJS globals the bundled dependencies (all CommonJS) reach for.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __esbuildDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __esbuildDirname(__filename);',
    ].join('\n'),
  },
});

console.log('mail service bundle written to dist/mail.mjs');
