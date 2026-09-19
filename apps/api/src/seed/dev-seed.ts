import { createKeyring, decodeMasterKey, type Env, encryptSecret } from '@helpdock/config';
import { brands, type Db, userBrandRoles, users, withSystem } from '@helpdock/db';
import { eq, sql } from 'drizzle-orm';
import { PasswordHasher } from '../auth/password.js';
import { newTotpSecret } from '../auth/totp/totp.js';

/**
 * A development install with somebody in it: one brand, one install admin, and
 * a password that is written down.
 *
 * It exists so that `VITE_AUTH_API=http` has something to sign into, and so the
 * Playwright project that drives the real api has a known account. It refuses
 * to run when `NODE_ENV=production`, because a published password is only
 * acceptable while everybody can read it in the repository.
 *
 * It is idempotent: running it twice leaves one brand and one account, and does
 * not reset a password that has been changed.
 */

export const DEV_ADMIN_EMAIL = 'admin@helpdock.test';
/** Twelve characters is the floor the reset form enforces; this clears it. */
export const DEV_ADMIN_PASSWORD = 'helpdock dev password';
const DEV_ADMIN_NAME = 'Dev Admin';
const DEV_BRAND_NAME = 'Helpdock Dev';
const DEV_BRAND_PREFIX = 'HD';

export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefusedError';
  }
}

export interface SeededInstall {
  readonly userId: string;
  readonly brandId: string;
  readonly email: string;
  readonly password: string;
  /** Base32, for an authenticator app or for a test that has to produce a code. */
  readonly totpSecret: string | null;
  readonly created: boolean;
}

export interface SeedDevInstallOptions {
  readonly db: Db;
  readonly env: Env;
  /** Enrols a second factor with a known secret, which the api e2e project needs. */
  readonly withTotp?: boolean;
  readonly log?: (message: string) => void;
}

export const seedDevInstall = async ({
  db,
  env,
  withTotp = false,
  log = () => {},
}: SeedDevInstallOptions): Promise<SeededInstall> => {
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusedError(
      'seed:dev refuses to run with NODE_ENV=production: it creates an account whose password is published in the repository',
    );
  }

  const brandId = await upsertBrand(db);
  const existing = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${DEV_ADMIN_EMAIL})`)
    .limit(1);

  const masterKey = decodeMasterKey(env.APP_MASTER_KEY);
  /* c8 ignore next 3 -- `loadEnv` has already refused anything that is not a 32-byte key. */
  if (masterKey === undefined) {
    throw new SeedRefusedError('APP_MASTER_KEY is not 32 bytes of base64');
  }

  const hasher = new PasswordHasher(masterKey);
  const totpSecret = withTotp ? newTotpSecret() : null;
  const totpColumns =
    totpSecret === null
      ? {}
      : {
          totpSecretEncrypted: encryptSecret(totpSecret, createKeyring(env)),
          totpEnabled: true,
        };

  const found = existing[0];
  const userId = found
    ? await refresh(db, found.id, totpColumns)
    : await insert(db, await hasher.hash(DEV_ADMIN_PASSWORD), totpColumns);

  await withSystem(db, brandId, async (tx) => {
    await tx
      .insert(userBrandRoles)
      .values({ userId, brandId, role: 'admin' })
      .onConflictDoNothing({ target: [userBrandRoles.userId, userBrandRoles.brandId] });
  });

  log(
    found
      ? `Development install already seeded; ${DEV_ADMIN_EMAIL} keeps the password it has.`
      : `Seeded ${DEV_ADMIN_EMAIL} as an install admin of ${DEV_BRAND_NAME}.`,
  );

  return {
    userId,
    brandId,
    email: DEV_ADMIN_EMAIL,
    password: DEV_ADMIN_PASSWORD,
    totpSecret,
    created: found === undefined,
  };
};

const upsertBrand = async (db: Db): Promise<string> => {
  const existing = await db
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.prefix, DEV_BRAND_PREFIX))
    .limit(1);

  const found = existing[0];
  if (found !== undefined) {
    return found.id;
  }

  const inserted = await db
    .insert(brands)
    .values({ name: DEV_BRAND_NAME, prefix: DEV_BRAND_PREFIX })
    .returning({ id: brands.id });

  const created = inserted[0];
  /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
  if (created === undefined) {
    throw new Error('The development brand could not be created');
  }

  return created.id;
};

const insert = async (
  db: Db,
  passwordHash: string,
  totpColumns: Record<string, unknown>,
): Promise<string> => {
  const inserted = await db
    .insert(users)
    .values({
      email: DEV_ADMIN_EMAIL,
      name: DEV_ADMIN_NAME,
      passwordHash,
      status: 'active',
      installAdmin: true,
      ...totpColumns,
    })
    .returning({ id: users.id });

  const created = inserted[0];
  /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
  if (created === undefined) {
    throw new Error('The development admin could not be created');
  }

  return created.id;
};

/**
 * An account that already exists keeps its password — an operator may have
 * changed it — but its second factor is re-enrolled when one is asked for, so a
 * test run always knows the secret it has to produce a code from.
 */
const refresh = async (
  db: Db,
  userId: string,
  totpColumns: Record<string, unknown>,
): Promise<string> => {
  if (Object.keys(totpColumns).length > 0) {
    await db.update(users).set(totpColumns).where(eq(users.id, userId));
  }

  return userId;
};
