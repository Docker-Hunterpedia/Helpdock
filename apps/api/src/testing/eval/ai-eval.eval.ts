import { loadEvalSuite, renderEvalMarkdown } from '@helpdock/ai';
import { afterAll, describe, expect, it } from 'vitest';
import { readEvalConfig } from './config.js';
import { type PreparedEvaluation, prepareEvaluation } from './run.js';
import { hasDocker } from './stack.js';

/**
 * `pnpm eval:ai` (M7-11): the evaluation of DOMAIN-RULES §9 as one test, so
 * a missed threshold is a non-zero exit and CI's nightly run fails. The
 * report is written either way, to `AI_EVAL_REPORT_DIR`, and printed here.
 *
 *   AI_EVAL_MODE=mock pnpm eval:ai      the faux provider, no network
 *   AI_EVAL_MODE=live ... pnpm eval:ai  a real provider; see config.ts
 */

const config = readEvalConfig(process.env);

describe.skipIf(!hasDocker && config.databaseUrl === undefined)(
  'AI evaluation (M7-11, DOMAIN-RULES §9)',
  () => {
    let evaluation: PreparedEvaluation | undefined;

    afterAll(async () => {
      await evaluation?.stop();
    });

    it(`meets every §9 threshold in English and Arabic (${config.mode} mode)`, async () => {
      evaluation = await prepareEvaluation({ config, suite: await loadEvalSuite() });
      const report = await evaluation.run();
      process.stdout.write(`\n${renderEvalMarkdown(report)}\n`);
      expect(
        report.score.locales.map((locale) => ({ locale: locale.locale, missed: locale.missed })),
      ).toEqual([
        { locale: 'en', missed: [] },
        { locale: 'ar', missed: [] },
      ]);
    }, 3_600_000);
  },
);
