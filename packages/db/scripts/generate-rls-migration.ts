import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  missingOwnerPolicies,
  missingPolicyTables,
  OWNER_SCOPED_TABLES,
  ownerPolicy,
  renderTenantPolicyStatements,
} from '../src/rls.ts';

/**
 * Appends the policies of any tenant table that has none yet to the newest
 * migration — the one `pnpm --filter @helpdock/db gen:migration` just wrote for
 * that table. Policies belong in the same migration as the `CREATE TABLE`
 * because migrations are forward-only: a statement that references a table an
 * earlier migration has not created yet would fail on a fresh database.
 *
 * Run it after adding a tenant table: `pnpm --filter @helpdock/db gen:rls`.
 * `rls.test.ts` fails while a tenant table has no policies in any committed
 * migration, so this cannot be forgotten.
 */

const directory = fileURLToPath(new URL('../drizzle/', import.meta.url));

const migrationFiles = async (): Promise<readonly string[]> =>
  (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort();

const files = await migrationFiles();
const latest = files.at(-1);
if (latest === undefined) {
  throw new Error(`No migration to append to in ${directory}. Run gen:migration first.`);
}

const committed = (
  await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))
).join('\n');

const missing = missingPolicyTables(committed);
// Owner policies go after the tenant ones, so a table's four brand policies
// always precede the restrictive policy that narrows them.
const missingOwners = OWNER_SCOPED_TABLES.filter(({ name }) =>
  missingOwnerPolicies(committed).includes(name),
);
if (missing.length === 0 && missingOwners.length === 0) {
  process.stdout.write('Every tenant table already has its policies. Nothing to write.\n');
} else {
  const target = path.join(directory, latest);
  const existing = await readFile(target, 'utf8');
  const tenant = missing.length === 0 ? '' : renderTenantPolicyStatements(missing);
  const owners = missingOwners
    .map(({ name, column }) => `--> statement-breakpoint\n${ownerPolicy(name, column)}\n`)
    .join('');
  await writeFile(target, `${existing.trimEnd()}\n${tenant}${owners}`, 'utf8');
  process.stdout.write(
    `Appended policies for ${[...missing.map((table) => table.name), ...missingOwners.map((table) => `${table.name} (owner)`)].join(', ')} to ${target}\n`,
  );
}
