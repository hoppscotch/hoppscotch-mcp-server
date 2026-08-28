import { defineConfig } from 'tsup';

// Single bin entry: `index` (the executable CLI). Code splitting keeps shared
// chunks (e.g. the dynamically-imported request executor) out of the main entry
// so the published tarball stays lean.
//
// The shebang banner lands on the ESM entry file (index.js), required for the
// bin.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  splitting: true,
  // Bin-only package, so no library type surface to ship.
  dts: false,
  clean: true,
  // No sourcemaps in the published artifact: they embed the full original
  // TypeScript (sourcesContent), which we don't ship to consumers.
  sourcemap: false,
  minify: false,
  target: 'node22',
  shims: true,
  // Bake the Cloud Firebase Web API key in from the RELEASE machine's
  // environment instead of hardcoding it in source. End users need no
  // configuration; the literal is not committed to source. A build without the var
  // set injects an empty string, and auth.ts then raises a clear Cloud-sign-in
  // error rather than calling Firebase with an empty key, and release.yml
  // refuses to publish such a build.
  define: {
    __FIREBASE_WEB_API_KEY__: JSON.stringify(process.env.HOPPSCOTCH_FIREBASE_API_KEY ?? ''),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
});
