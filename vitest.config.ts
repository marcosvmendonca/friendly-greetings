import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Tests import through the `@/` path alias (matching tsconfig paths).
// Without this, vitest resolves `@/lib/...` as a bare package and every
// suite that crosses a module boundary fails to import.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
