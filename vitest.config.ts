import { defineConfig } from 'vitest/config';

/**
 * Two test projects:
 *  - unit:        pure logic (analytics, security, ai router, connectors parsing)
 *  - integration: anything touching a database (embedded PGlite), HTTP (Fastify inject),
 *                 the agent orchestrator, the MVP factory sandbox and the end-to-end flow.
 *
 * Integration tests use an in-memory PGlite Postgres, so no Docker is required to run them.
 * Set TEST_DATABASE_URL to run the same suite against a real Postgres server.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/analytics/test/**/*.test.ts',
            'packages/security/test/**/*.test.ts',
            'packages/shared/test/**/*.test.ts',
            'packages/ai/test/**/*.test.ts',
            'packages/connectors/test/**/*.test.ts',
            'packages/billing/test/**/*.test.ts',
          ],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'packages/database/test/**/*.test.ts',
            'packages/core/test/**/*.test.ts',
            'packages/agents/test/**/*.test.ts',
            'packages/factory/test/**/*.test.ts',
            'apps/api/test/**/*.test.ts',
            'tests/**/*.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          fileParallelism: true,
        },
      },
    ],
  },
});
