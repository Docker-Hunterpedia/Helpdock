import { loadEnv } from '@helpdock/config';
import { appRolePasswordFromUrl, createDb, runMigrations } from '@helpdock/db';
import { DEV_ADMIN_PASSWORD, seedDevInstall } from './dev-seed.js';

/**
 * `pnpm --filter @helpdock/api seed:dev`.
 *
 * It migrates first, so it works against an empty database, and then creates
 * the development install. Everything it does is in `dev-seed.ts`; this file is
 * the process around it, the same shape as `main.ts`.
 *
 * | Flag | |
 * |---|---|
 * | `--with-totp` | Enrols a second factor and reports the secret. The browser test that drives the real api needs one it can produce codes from. |
 * | `--with-invite` | Leaves one unaccepted invitation and reports its token, so the invite screen has a live link to open. |
 * | `--json` | Prints one JSON line instead of prose, for a script to read. |
 */

const main = async (): Promise<void> => {
  const flags = new Set(process.argv.slice(2));
  const asJson = flags.has('--json');
  const env = loadEnv();
  const say = (message: string): void => {
    if (!asJson) {
      process.stdout.write(`${message}\n`);
    }
  };

  await runMigrations({
    migrationUrl: env.DATABASE_MIGRATION_URL,
    appRolePassword: appRolePasswordFromUrl(env.DATABASE_URL),
    log: say,
  });

  const { db, close } = createDb({ url: env.DATABASE_URL });
  try {
    const seeded = await seedDevInstall({
      db,
      env,
      withTotp: flags.has('--with-totp'),
      withInvite: flags.has('--with-invite'),
      log: say,
    });

    if (asJson) {
      process.stdout.write(`${JSON.stringify(seeded)}\n`);
      return;
    }

    process.stdout.write(
      `\nSign in at ${env.APP_URL} with:\n  ${seeded.email}\n  ${DEV_ADMIN_PASSWORD}\n`,
    );
    if (seeded.totpSecret !== null) {
      process.stdout.write(`  authenticator secret: ${seeded.totpSecret}\n`);
    }
    if (seeded.inviteToken !== null) {
      process.stdout.write(`\nA pending invitation: ${env.APP_URL}/invite/${seeded.inviteToken}\n`);
    }
  } finally {
    await close();
  }
};

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
