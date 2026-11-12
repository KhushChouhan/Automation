import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
    environment: 'node',
    include: ['packages/**/*.test.ts', 'packages/**/*.test.mjs', 'apps/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
