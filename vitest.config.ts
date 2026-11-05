import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Web component tests opt into jsdom with a `@vitest-environment jsdom` comment.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
