import { defineConfig } from 'vite';

const buildId = String(
  process.env.VITE_BUILD_ID
  || process.env.SOURCE_VERSION
  || process.env.HEROKU_SLUG_COMMIT
  || 'dev',
).slice(0, 12);

export default defineConfig({
  define: {
    __VIZIER_BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    port: 8082,
    strictPort: true,
    // Disable caching during development
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    }
  },
  // Force rebuild on every change
  optimizeDeps: {
    force: true,
    // pdfjs-dist is only reached through a lazy `import("pdfjs-dist")` in
    // intake-client.js (on PDF upload). Without listing it here, Vite does not
    // pre-bundle it, so the first upload triggers an on-the-fly re-optimization
    // + full reload that aborts the in-flight import ("Failed to fetch
    // dynamically imported module"). Pre-bundling it at startup fixes that.
    include: ['pdfjs-dist']
  },
  build: {
    // Clear output dir before build
    emptyOutDir: true
  }
});
