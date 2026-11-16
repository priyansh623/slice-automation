import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Components are rendered to static markup in some tests; tsconfig keeps jsx as "preserve" for Next, so Vite needs the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', '.next'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
