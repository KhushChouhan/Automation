import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
