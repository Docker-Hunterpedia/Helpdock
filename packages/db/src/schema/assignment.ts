import { boolean, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { tags } from './tags.js';
import { users } from './users.js';

/**
 * M1-07: one person's standing in one department's rotation (REQUIREMENTS
 * §4.1).
 *
 * A row is written only when somebody changes the default or the rotation
 * hands the person a ticket, so a department with no rows is one whose Agents
 * are all in rotation and have never been picked. Who *may* be in it is not
 * stored here: that is `user_brand_roles`, read at the moment of picking, so a
 * scope change can never leave a stale row routing work to somebody who can no
 * longer see it.
 *
 * Brand-scoped, not department-scoped, like `teams`: it is configuration a
 * Team Leader edits for the departments they lead, which is a service rule
 * (`brands/department-scope.ts`), not a ticket.
 */
export const assignmentAgents = pgTable(
  'assignment_agents',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inRotation: boolean('in_rotation').notNull(),
    /**
     * When the rotation last gave this person a ticket here. "Longest waiting"
     * is the oldest value, and never-picked (null) sorts first.
     */
    lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true, precision: 3 }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({
      name: 'assignment_agents_pkey',
      columns: [table.departmentId, table.userId],
    }),
    index('assignment_agents_brand_user_idx').on(table.brandId, table.userId),
  ],
);

export type AssignmentAgent = typeof assignmentAgents.$inferSelect;
export type NewAssignmentAgent = typeof assignmentAgents.$inferInsert;

/**
 * M1-07: an agent's skills in one department, as tags (REQUIREMENTS §4.1:
 * "tags on agents ↔ ticket tags"). Per department rather than per person, so a
 * Team Leader edits the skills that matter in the departments they lead and
 * nobody else's.
 *
 * A deleted tag takes its skill rows with it, the same way it leaves every
 * ticket that carried it.
 */
export const assignmentSkills = pgTable(
  'assignment_skills',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'assignment_skills_pkey',
      columns: [table.departmentId, table.userId, table.tagId],
    }),
    index('assignment_skills_brand_tag_idx').on(table.brandId, table.tagId),
  ],
);

export type AssignmentSkill = typeof assignmentSkills.$inferSelect;
export type NewAssignmentSkill = typeof assignmentSkills.$inferInsert;
