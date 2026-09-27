import { fileURLToPath } from 'node:url';
import { measure, overBudget, report } from './budget.ts';

/**
 * `pnpm --filter @helpdock/widget size`: builds, then prints the gzipped size
 * of every file and fails when the build is over the D §14 budget. CI enforces
 * the same budget through `scripts/size.test.ts` in the `unit` job.
 */
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const files = await measure(dist);
console.log(report(files));

const problems = overBudget(files);
if (problems.length > 0) {
  console.error(`\nOver budget:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log('\nWithin the widget budget (DOMAIN-RULES §14).');
