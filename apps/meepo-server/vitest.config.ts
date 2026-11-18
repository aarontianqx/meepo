import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    // Stale-cron tests walk ~10k cron fires (about 1s idle); the 5s default
    // times out on a shared 4-vCPU CI runner, so allow headroom.
    testTimeout: 30_000,
  },
});
