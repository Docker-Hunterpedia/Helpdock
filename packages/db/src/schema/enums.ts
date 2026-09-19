import { pgEnum } from 'drizzle-orm/pg-core';

/** Interface and content languages Helpdock ships with (REQUIREMENTS §3). */
export const localeEnum = pgEnum('locale', ['en', 'ar']);

/** Staff account state (DOMAIN-RULES §12). */
export const userStatusEnum = pgEnum('user_status', ['invited', 'active', 'deactivated']);

/** Brand state. `deleting` is the 30-day grace window of DOMAIN-RULES §11. */
export const brandStatusEnum = pgEnum('brand_status', ['active', 'deleting', 'deleted']);

/** One role per user per brand (DOMAIN-RULES §1.2). */
export const brandRoleEnum = pgEnum('brand_role', ['admin', 'team_leader', 'agent', 'viewer']);

/** The principal kinds of DOMAIN-RULES §1.1, as recorded on an audit row. */
export const actorTypeEnum = pgEnum('actor_type', ['staff', 'visitor', 'apikey', 'system']);

/** What a brand hostname is for (ARCHITECTURE §5). */
export const brandDomainKindEnum = pgEnum('brand_domain_kind', ['helpcenter', 'widget_origin']);

/**
 * How a contact can be reached, and how Helpdock recognises them again
 * (DOMAIN-RULES §4.4). `external` is the brand's own user id, carried by a
 * signed identity; `visitor` is the id the widget issues on first load.
 */
export const contactIdentityKindEnum = pgEnum('contact_identity_kind', [
  'email',
  'phone',
  'telegram',
  'visitor',
  'external',
]);

/** What became of a possible-duplicate suggestion (DOMAIN-RULES §4.4). */
export const contactDuplicateStatusEnum = pgEnum('contact_duplicate_status', [
  'open',
  'dismissed',
  'merged',
]);
