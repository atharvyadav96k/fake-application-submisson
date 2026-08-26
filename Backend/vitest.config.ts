import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Without this, a build left in place is collected a second time from dist/.
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    restoreMocks: true,
  },
});
