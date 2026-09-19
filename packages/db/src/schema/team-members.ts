import { index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { teams } from './teams.js';
import { users } from './users.js';

/**
 * Who is on a team. Tenant table: row-level security restricts it to the brands
 * in `app.brand_ids`, which is why it carries `brand_id` even though the team
 * it points at already knows one — a policy that had to join to find the brand
 * would be a policy nobody could read (DOMAIN-RULES §1.3).
 *
 * There is no foreign key to `user_brand_roles`: the rule that a member must
 * hold a role in the brand whose department scope reaches this team's
 * department is wider than any single constraint can express, so it is checked
 * in the service, inside the brand's own transaction. Losing the role does not
 * delete the row — it removes the person from the pickers, and the membership
 * comes back with the role, which is what an administrator fixing a mistake
 * expects.
 */
export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('team_members_team_user_key').on(table.teamId, table.userId),
    // "Which teams is this person on?" is what the staff screens and M1-07's
    // round-robin ask, and they ask it per brand.
    index('team_members_brand_user_idx').on(table.brandId, table.userId),
  ],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
