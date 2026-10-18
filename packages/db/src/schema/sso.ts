import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { brandRoleEnum } from './enums.js';
import { users } from './users.js';

export const ssoProtocolEnum = pgEnum('sso_protocol', ['oidc', 'saml']);
export const brandRoleSourceEnum = pgEnum('brand_role_source', ['manual', 'sso']);

/** Install-scoped auth configuration, accessed only by install admins and the pre-tenant sign-in path. */
export const ssoConnections = pgTable(
  'sso_connections',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: varchar('name', { length: 80 }).notNull(),
    protocol: ssoProtocolEnum('protocol').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    emailDomains: text('email_domains').array().notNull().default(sql`'{}'::text[]`),
    jitEnabled: boolean('jit_enabled').notNull().default(true),
    idpEnforcesMfa: boolean('idp_enforces_mfa').notNull().default(false),
    defaultAccess: jsonb('default_access'),
    groupAttribute: varchar('group_attribute', { length: 200 }),
    config: jsonb('config').notNull().$type<Record<string, unknown>>(),
    secretEncrypted: text('secret_encrypted'),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('sso_connections_name_lower_key').on(sql`lower(${table.name})`)],
);

/** Install-scoped cross-brand grants, administered through install:admin rather than brand routes. */
export const ssoRoleMappings = pgTable(
  'sso_role_mappings',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    idpGroup: varchar('idp_group', { length: 300 }).notNull(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    role: brandRoleEnum('role').notNull(),
    departmentIds: uuid('department_ids').array(),
    position: integer('position').notNull(),
  },
  (table) => [
    unique('sso_mapping_group_brand_key').on(table.connectionId, table.idpGroup, table.brandId),
  ],
);

/** Install-scoped identity links; authentication precedes any tenant context. */
export const userSsoIdentities = pgTable(
  'user_sso_identities',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'restrict' }),
    subject: varchar('subject', { length: 300 }).notNull(),
    emailAtLink: varchar('email_at_link', { length: 320 }).notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  },
  (table) => [
    unique('sso_identity_subject_key').on(table.connectionId, table.subject),
    // One subject per account and connection: email linking cannot add a second.
    unique('sso_identity_user_connection_key').on(table.userId, table.connectionId),
  ],
);
