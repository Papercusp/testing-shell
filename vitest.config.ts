import { defineConfig } from 'vitest/config';
import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config';

// Previously no vitest config (vitest defaults). Adds only the /admin/testing
// status-chip reporter; everything else stays vitest-default. Fail-soft; opt-out via env.
export default defineConfig({
  test: {
    reporters:
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? ['default']
        : ['default', ADMIN_TEST_RUNS_REPORTER_PATH],
  },
});
