import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js', 'src/**/__tests__/**/*.test.js'],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
    pool: 'forks',
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
    coverage: { provider: 'v8', include: ['src/**/*.js'], exclude: ['src/apps/**'] },
  },
});
