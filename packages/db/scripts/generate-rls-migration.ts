import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingPolicyTables, renderTenantPolicyStatements } from '../src/rls.ts';

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
if (missing.length === 0) {
  process.stdout.write('Every tenant table already has its policies. Nothing to write.\n');
} else {
  const target = path.join(directory, latest);
  const existing = await readFile(target, 'utf8');
  await writeFile(
    target,
    `${existing.trimEnd()}\n${renderTenantPolicyStatements(missing)}`,
    'utf8',
  );
  process.stdout.write(
    `Appended policies for ${missing.map((table) => table.name).join(', ')} to ${target}\n`,
  );
}
