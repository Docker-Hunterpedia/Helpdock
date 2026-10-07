import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `pnpm eval:ai` (M7-11): the evaluation of DOMAIN-RULES §9 in
 * `src/testing/eval/ai-eval.eval.ts`. Its own config, like the performance
 * gates', because it is neither a unit nor an integration suite: in live
 * mode it spends real provider calls and runs nightly, never on a pull
 * request. Mock mode is what `ai-eval.integration.test.ts` covers in CI.
 */
export default defineConfig({
  resolve: {
    dedupe: ['zod', 'nestjs-zod'],
    alias: {
      '@helpdock/ai': fileURLToPath(new URL('../../packages/ai/src/index.ts', import.meta.url)),
      '@helpdock/channels': fileURLToPath(
        new URL('../../packages/channels/src/index.ts', import.meta.url),
      ),
      '@helpdock/config': fileURLToPath(
        new URL('../../packages/config/src/index.ts', import.meta.url),
      ),
      '@helpdock/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@helpdock/jobs': fileURLToPath(new URL('../../packages/jobs/src/index.ts', import.meta.url)),
      '@helpdock/schemas': fileURLToPath(
        new URL('../../packages/schemas/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: '@helpdock/api-ai-eval',
    include: ['src/testing/eval/**/*.eval.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    reporters: ['verbose'],
  },
});
