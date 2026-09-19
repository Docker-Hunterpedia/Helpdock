import type { RuntimeRoleFacts } from '@helpdock/db';

/**
 * What boot learned and nothing else can ask for afterwards.
 *
 * Both facts are read by a connection the request path does not have:
 * `assertRuntimeRoleIsSafe` is the check that decided whether this process may
 * serve at all (DOMAIN-RULES §1.5), and the migration count comes from the
 * owner connection, because the runtime role is deliberately not granted the
 * `drizzle` schema that holds the log.
 *
 * Keeping the answers rather than asking again also keeps them honest: the
 * System page reports the state this replica actually booted into.
 */
export interface BootFacts {
  readonly runtimeRole: RuntimeRoleFacts;
  /**
   * Migrations recorded when this replica booted, or `null` for a role that
   * does not migrate — a worker, which never runs them (ARCHITECTURE §17).
   */
  readonly migrationsApplied: number | null;
}
