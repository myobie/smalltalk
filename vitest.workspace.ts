// Two test pools:
// - unit: tests/unit/**, fast, no I/O serialization needed.
// - integration: tests/integration/**, real /tmp dirs and rsync subprocesses,
//   forced single-fork so they don't race each other on shared resources.

import { defineWorkspace } from 'vitest/config';

// `setupFiles` runs in every worker BEFORE any test imports — see
// tests/setup/pty-isolation.ts for the load-bearing reason (brief-020).
const SETUP_FILES = ['./tests/setup/pty-isolation.ts'];

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
      testTimeout: 10_000,
      clearMocks: true,
      restoreMocks: true,
      setupFiles: SETUP_FILES,
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      clearMocks: true,
      restoreMocks: true,
      pool: 'forks',
      poolOptions: {
        forks: { singleFork: true },
      },
      setupFiles: SETUP_FILES,
    },
  },
]);
