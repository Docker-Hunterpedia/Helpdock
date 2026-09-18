import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderTenantPolicyMigration } from '../src/rls.ts';

/**
 * Rewrites the policy migration from `TENANT_TABLES`. Run it after adding a
 * tenant table: `pnpm --filter @helpdock/db gen:rls`. `rls.test.ts` fails when
 * the committed file and the generator disagree, so this cannot be forgotten.
 */
const path = fileURLToPath(new URL('../drizzle/0002_tenant_rls_policies.sql', import.meta.url));

await writeFile(path, renderTenantPolicyMigration(), 'utf8');
process.stdout.write(`Wrote ${path}\n`);
