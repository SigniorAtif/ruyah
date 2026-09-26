import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The suite covers the sync core only — the clock, the engine's command and
 * drift machinery, and the relay — so it runs in plain node with no DOM. The
 * engine already guards every `document` and `requestAnimationFrame` touch
 * (§12 has to survive a background tab), and the tests hand it a fake video
 * element, so jsdom would add startup cost and hide those guards rather than
 * exercise them.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The clock and the engine both schedule far into the future; nothing here
    // waits on real time, so a short timeout catches a hung fake clock fast.
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  define: {
    // Mirrors next.config.ts: the engine's dev-only console handle is compiled
    // out of production, and the tests run with it off.
    __RUYAH_DEV_TOOLS__: 'false',
  },
});
