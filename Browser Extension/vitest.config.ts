import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./extension/src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    // Tests run as if served from a configured portal origin, so history APIs and
    // origin checks behave the way they do in the extension's real context.
    environmentOptions: { jsdom: { url: 'https://jobs.example-portal.com/' } },
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['extension/src/**/*.ts'],
      exclude: ['extension/src/popup/**', 'extension/src/collector/content/page-hook.ts'],
    },
  },
});
