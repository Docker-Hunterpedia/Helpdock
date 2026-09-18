import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only generates SQL here; it never touches a database. Migrations
 * are applied by `runMigrations` at api boot, under an advisory lock and as the
 * owner role (DOMAIN-RULES §1.5), so `drizzle-kit migrate` and `push` are not
 * part of any workflow.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
  strict: true,
  verbose: true,
});
