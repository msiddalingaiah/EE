// UI tests (npm run test:ui): the editor driven in headless Chrome by scripts/drive.mjs.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/ui/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
