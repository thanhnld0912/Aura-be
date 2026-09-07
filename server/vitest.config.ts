import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share a database and a port range; run them serially.
    fileParallelism: false,
    clearMocks: true,
  },
});
