import path from 'node:path';
import { z } from 'zod';

/**
 * What `pnpm eval:ai` reads from the environment (M7-11). Every variable is
 * `AI_EVAL_*`, apart from the app's own configuration on purpose: the run
 * starts its own install in containers and configures the models from these.
 *
 * - `AI_EVAL_MODE`: `mock` (the default; pi-ai's faux provider and fake
 *   embeddings, no network) or `live` (a real provider, the nightly run).
 * - live mode: `AI_EVAL_PROVIDER_KIND` (a pi-ai provider id such as `openai`
 *   or `anthropic`, or `openai-compatible`), `AI_EVAL_API_KEY`,
 *   `AI_EVAL_BASE_URL` (required for `openai-compatible`), `AI_EVAL_MODEL`,
 *   `AI_EVAL_JUDGE_MODEL` (the chat model unless set), and the embeddings
 *   endpoint `AI_EVAL_EMBEDDING_BASE_URL`, `AI_EVAL_EMBEDDING_API_KEY`,
 *   `AI_EVAL_EMBEDDING_MODEL`, `AI_EVAL_EMBEDDING_DIMS`.
 * - `AI_EVAL_THRESHOLD`: the auto-reply confidence threshold (0.7, the
 *   brand default). `AI_EVAL_CONCURRENCY`: items in flight (4).
 * - `AI_EVAL_REPORT_DIR`: where `report.json` and `report.md` go
 *   (`apps/api/eval-report`).
 * - `AI_EVAL_DATABASE_URL` and `AI_EVAL_REDIS_URL`: a throwaway Postgres
 *   with pgvector (its owner connection) and a Redis to use instead of
 *   Testcontainers; the run migrates and seeds them.
 */

export const DEFAULT_REPORT_DIR = path.resolve(import.meta.dirname, '../../../eval-report');

const optional = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const liveSchema = z
  .object({
    providerKind: z.string().trim().min(1),
    apiKey: optional,
    baseUrl: z.url({ protocol: /^https?$/ }).optional(),
    model: z.string().trim().min(1),
    judgeModel: optional,
    embeddings: z.object({
      baseUrl: z.url({ protocol: /^https?$/ }),
      apiKey: optional,
      model: z.string().trim().min(1),
      dims: z.coerce.number().int().min(1).max(2000),
    }),
  })
  .refine((live) => live.providerKind !== 'openai-compatible' || live.baseUrl !== undefined, {
    message: 'AI_EVAL_BASE_URL is required for an openai-compatible provider',
    path: ['baseUrl'],
  });

export type LiveEvalConfig = z.infer<typeof liveSchema>;

export interface EvalConfig {
  readonly mode: 'mock' | 'live';
  readonly live: LiveEvalConfig | null;
  readonly threshold: number;
  readonly concurrency: number;
  readonly reportDir: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
}

const commonSchema = z.object({
  AI_EVAL_MODE: z.enum(['mock', 'live']).default('mock'),
  AI_EVAL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  AI_EVAL_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  AI_EVAL_REPORT_DIR: optional,
  AI_EVAL_DATABASE_URL: optional,
  AI_EVAL_REDIS_URL: optional,
});

const blankToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

export const readEvalConfig = (env: Readonly<Record<string, string | undefined>>): EvalConfig => {
  const common = commonSchema.parse({
    AI_EVAL_MODE: blankToUndefined(env.AI_EVAL_MODE),
    AI_EVAL_THRESHOLD: blankToUndefined(env.AI_EVAL_THRESHOLD),
    AI_EVAL_CONCURRENCY: blankToUndefined(env.AI_EVAL_CONCURRENCY),
    AI_EVAL_REPORT_DIR: env.AI_EVAL_REPORT_DIR,
    AI_EVAL_DATABASE_URL: env.AI_EVAL_DATABASE_URL,
    AI_EVAL_REDIS_URL: env.AI_EVAL_REDIS_URL,
  });
  if ((common.AI_EVAL_DATABASE_URL === undefined) !== (common.AI_EVAL_REDIS_URL === undefined)) {
    throw new Error('AI_EVAL_DATABASE_URL and AI_EVAL_REDIS_URL are set together or not at all');
  }
  const live =
    common.AI_EVAL_MODE === 'live'
      ? liveSchema.parse({
          providerKind: env.AI_EVAL_PROVIDER_KIND,
          apiKey: env.AI_EVAL_API_KEY,
          baseUrl: blankToUndefined(env.AI_EVAL_BASE_URL),
          model: env.AI_EVAL_MODEL,
          judgeModel: env.AI_EVAL_JUDGE_MODEL,
          embeddings: {
            baseUrl: env.AI_EVAL_EMBEDDING_BASE_URL,
            apiKey: env.AI_EVAL_EMBEDDING_API_KEY,
            model: env.AI_EVAL_EMBEDDING_MODEL,
            dims: env.AI_EVAL_EMBEDDING_DIMS,
          },
        })
      : null;
  return {
    mode: common.AI_EVAL_MODE,
    live,
    threshold: common.AI_EVAL_THRESHOLD,
    concurrency: common.AI_EVAL_CONCURRENCY,
    reportDir: common.AI_EVAL_REPORT_DIR ?? DEFAULT_REPORT_DIR,
    databaseUrl: common.AI_EVAL_DATABASE_URL,
    redisUrl: common.AI_EVAL_REDIS_URL,
  };
};
