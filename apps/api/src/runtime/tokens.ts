/**
 * Injection tokens for the things the process builds before Nest exists: the
 * validated environment, the database pool, the settings resolver and the Redis
 * client. Boot has to run migrations and prove the runtime database role cannot
 * bypass row-level security *before* anything is served (DOMAIN-RULES §1.5), so
 * these are value providers rather than Nest factories.
 */

export const ENV = Symbol('helpdock.env');
export const DB = Symbol('helpdock.db');
export const SETTINGS = Symbol('helpdock.settings');
export const REDIS = Symbol('helpdock.redis');
export const LOGGER = Symbol('helpdock.logger');

/** Replaced by the session resolver in M0-05; see `src/auth/principal-resolver.ts`. */
export const PRINCIPAL_RESOLVER = Symbol('helpdock.principal-resolver');
/** Filled in by M5, when brand domains exist; see `src/context/brand-resolver.ts`. */
export const BRAND_RESOLVER = Symbol('helpdock.brand-resolver');
