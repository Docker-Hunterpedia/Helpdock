import { createKeyring, decodeMasterKey, type Env, encryptSecret } from '@helpdock/config';
import {
  auditLog,
  brands,
  type Db,
  seedBrandStatuses,
  userBrandRoles,
  users,
  withSystem,
} from '@helpdock/db';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { EmailTokenStore } from '../auth/email-token.store.js';
import { PasswordHasher } from '../auth/password.js';
import { newTotpSecret } from '../auth/totp/totp.js';
import { INVITE_TTL_SECONDS, InviteStore } from '../staff/invite.store.js';

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
/** The address `--with-invite` leaves an unaccepted invitation for. */
export const DEV_INVITEE_EMAIL = 'invitee@helpdock.test';
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
  /**
   * A live invitation for {@link DEV_INVITEE_EMAIL}, when `--with-invite` asked
   * for one. It is the token itself, which is why this only ever runs outside
   * production: the browser test that drives the real api has to follow the
   * link, and nothing logs an invitation's body.
   */
  readonly inviteToken: string | null;
  readonly created: boolean;
}

export interface SeedDevInstallOptions {
  readonly db: Db;
  readonly env: Env;
  /** Enrols a second factor with a known secret, which the api e2e project needs. */
  readonly withTotp?: boolean;
  /** Leaves an unaccepted invitation and reports its token (M0-06). */
  readonly withInvite?: boolean;
  readonly log?: (message: string) => void;
}

export const seedDevInstall = async ({
  db,
  env,
  withTotp = false,
  withInvite = false,
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

    // Idempotent, so re-seeding an install that already has them adds nothing.
    await seedBrandStatuses(tx, brandId);
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
    inviteToken: withInvite
      ? await inviteDevStaff({ db, env, brandId, inviterId: userId, log })
      : null,
    created: found === undefined,
  };
};

/**
 * One pending invitation, written the way the api writes one: an `invited`
 * account, a role in the brand, a token in `EmailTokenStore` and the record
 * `InviteStore` keeps so the staff list can print the dates.
 *
 * It is here rather than in the staff service because seeding happens in its
 * own process, before the api is running, and because the token has to come
 * back out — which the api deliberately never does.
 */
const inviteDevStaff = async ({
  db,
  env,
  brandId,
  inviterId,
  log,
}: {
  readonly db: Db;
  readonly env: Env;
  readonly brandId: string;
  readonly inviterId: string;
  readonly log: (message: string) => void;
}): Promise<string> => {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${DEV_INVITEE_EMAIL})`)
    .limit(1);

  const userId =
    existing[0]?.id ??
    (
      await db
        .insert(users)
        .values({ email: DEV_INVITEE_EMAIL, name: 'invitee', status: 'invited' })
        .returning({ id: users.id })
    )[0]?.id;

  /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
  if (userId === undefined) {
    throw new SeedRefusedError('The invited account could not be created');
  }

  await withSystem(db, brandId, async (tx) => {
    await tx
      .insert(userBrandRoles)
      .values({ userId, brandId, role: 'agent', departmentIds: [] })
      .onConflictDoNothing({ target: [userBrandRoles.userId, userBrandRoles.brandId] });

    // The same row the api writes, so the invite screen can name who sent it.
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: inviterId,
      action: 'staff.invited',
      targetType: 'user',
      targetId: userId,
      meta: { email: DEV_INVITEE_EMAIL, role: 'agent', departmentIds: [] },
    });
  });

  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  try {
    const tokens = new EmailTokenStore(redis);
    const issuedAt = Date.now();
    const token = await tokens.issue(
      {
        purpose: 'invite',
        userId,
        email: DEV_INVITEE_EMAIL,
        brandId,
        role: 'agent',
        departmentIds: [],
        issuedAt,
      },
      INVITE_TTL_SECONDS,
    );

    await new InviteStore(redis).remember(
      brandId,
      userId,
      {
        tokenHash: tokens.hashOf(token),
        issuedAt,
        expiresAt: issuedAt + INVITE_TTL_SECONDS * 1000,
      },
      INVITE_TTL_SECONDS,
    );

    log(`Left a pending invitation for ${DEV_INVITEE_EMAIL}.`);

    return token;
  } finally {
    await redis.quit();
  }
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
