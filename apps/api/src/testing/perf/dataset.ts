import {
  brands,
  brandTicketSequenceName,
  type Db,
  type DbTransaction,
  departments,
  seedBrandStatuses,
  tags,
  ticketStatuses,
  userBrandRoles,
  users,
  withSystem,
} from '@helpdock/db';
import { type SQL, sql } from 'drizzle-orm';

/**
 * The dataset of DOMAIN-RULES §14, for the ticket list's performance gate
 * (M1-15): five brands, and in the measured one 50 000 tickets, 200 000
 * messages and 20 000 contacts.
 *
 * The rows are written by `INSERT … SELECT generate_series(…)` inside the
 * brand's own system transaction, so they pass through the same row-level
 * security policies and department triggers the api's writes do, and a run
 * seeds in about a minute instead of the hours a request per ticket would take.
 *
 * The shape is what a desk looks like after two years, because an index that
 * is fast on uniform data can be slow on a real one:
 *
 * - **Most tickets are closed.** 70 % Closed, 3 % Spam, 2 % Merged; the live
 *   queues (Open 14 %, Awaiting customer 8 %, Escalated 3 %) are the small,
 *   recently-touched minority the default views ask for.
 * - **Departments are uneven** (45/20/15/12/8 %), so an agent confined to the
 *   two small ones filters most rows out of a brand-wide ordering.
 * - **Assignees are spread over twenty people**, and a quarter of the live
 *   tickets are unassigned.
 * - **Tags follow a power law**: a few are on thousands of tickets, most on a
 *   handful.
 *
 * Every random choice is seeded (`setseed`), so two runs of the same options
 * produce the same rows. Articles and knowledge chunks, which §14 also lists,
 * have no tables until M5 and are left out.
 */

export interface DatasetScale {
  readonly tickets: number;
  readonly contacts: number;
  /** Messages per ticket on average; each ticket gets between 1 and 2n − 1. */
  readonly messagesPerTicket: number;
}

export interface DatasetOptions {
  /** The brand the benchmark reads. §14: 50 000 tickets, 200 000 messages, 20 000 contacts. */
  readonly measured: DatasetScale;
  /** The other four brands, which exist so that brand isolation filters something out. */
  readonly others: DatasetScale;
  /** Argon2 hash of the password the two signed-in accounts use. */
  readonly passwordHash: string;
  readonly log?: (message: string) => void;
}

export const DOMAIN_RULES_14: Omit<DatasetOptions, 'passwordHash' | 'log'> = {
  measured: { tickets: 50_000, contacts: 20_000, messagesPerTicket: 4 },
  others: { tickets: 10_000, contacts: 4_000, messagesPerTicket: 4 },
};

export interface SeededAccount {
  readonly id: string;
  readonly email: string;
}

export interface PerfDataset {
  readonly brandId: string;
  /** Admin of the measured brand: department scope `all`. */
  readonly admin: SeededAccount;
  /** Agent confined to the two smallest departments of the measured brand. */
  readonly agent: SeededAccount;
  readonly agentDepartmentIds: readonly string[];
  /** Two tags that are on the same tickets often enough for an all-of filter to return a page. */
  readonly tagPair: readonly [string, string];
}

/** Department names and their share of the measured brand's tickets. */
const DEPARTMENTS = [
  ['Support', 0.45],
  ['Billing', 0.2],
  ['Sales', 0.15],
  ['Technical', 0.12],
  ['Returns', 0.08],
] as const;

/** The agent's departments: the two smallest, which is the hardest case for a brand-wide ordering. */
const AGENT_DEPARTMENTS = ['Technical', 'Returns'] as const;

const STAFF_PER_BRAND = 20;
const TAGS_PER_BRAND = 30;

const TOPICS = [
  'Refund for',
  'Cannot log in to',
  'Invoice missing for',
  'Shipping delay on',
  'Password reset for',
  'Question about',
  'Upgrade plan for',
  'Cancel subscription for',
  'Bug report in',
  'Payment failed for',
  'Change delivery address for',
  'Damaged item in',
  'Account locked after',
  'Discount code not working on',
  'Export data from',
  'Integration broken with',
];

const OBJECTS = [
  'order',
  'dashboard',
  'mobile app',
  'renewal',
  'invoice',
  'account',
  'shipment',
  'API',
  'checkout',
  'warranty',
];

const uuidArray = (ids: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;

const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

/** `CASE WHEN r < 0.45 THEN d[1] WHEN r < 0.65 THEN d[2] … END` over cumulative shares. */
const weighted = (random: SQL, choices: readonly (readonly [SQL, number])[]): SQL => {
  let cumulative = 0;
  const branches = choices.map(([value, share]) => {
    cumulative += share;
    return sql`WHEN ${random} < ${cumulative} THEN ${value}`;
  });

  return sql`(CASE ${sql.join(branches, sql` `)} ELSE ${choices.at(-1)?.[0] ?? sql`NULL`} END)`;
};

interface BrandShape {
  readonly name: string;
  readonly prefix: string;
  readonly scale: DatasetScale;
  readonly seed: number;
}

interface SeededBrand {
  readonly brandId: string;
  readonly departmentIds: ReadonlyMap<string, string>;
  readonly staffIds: readonly string[];
  readonly tagIds: readonly string[];
}

const statusIdsOf = async (tx: DbTransaction): Promise<Record<string, string>> => {
  const rows = await tx
    .select({ id: ticketStatuses.id, name: ticketStatuses.name })
    .from(ticketStatuses);
  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
};

const insertContacts = (tx: DbTransaction, brandId: string, count: number) =>
  tx.execute(sql`
    INSERT INTO contacts (id, brand_id, name, created_at, updated_at)
    SELECT gen_random_uuid(), ${brandId}::uuid,
           (${textArray(FIRST_NAMES)})[1 + floor(random() * ${FIRST_NAMES.length})::int] || ' ' ||
           (${textArray(LAST_NAMES)})[1 + floor(random() * ${LAST_NAMES.length})::int],
           now() - random() * interval '730 days', now() - random() * interval '30 days'
    FROM generate_series(1, ${count})
  `);

const insertTickets = (
  tx: DbTransaction,
  brand: SeededBrand,
  prefix: string,
  count: number,
  statuses: Record<string, string>,
) => {
  const departmentIds = DEPARTMENTS.map(
    ([name, share]) => [sql`${brand.departmentIds.get(name) ?? ''}::uuid`, share] as const,
  );
  const status = (name: string): SQL => sql`${statuses[name] ?? ''}::uuid`;

  return tx.execute(sql`
    WITH people AS (
      SELECT (SELECT array_agg(id ORDER BY id) FROM contacts) AS contacts,
             ${uuidArray(brand.staffIds)} AS staff
    ),
    draws AS (
      SELECT g AS n, random() AS r_state, random() AS r_department, random() AS r_age,
             random() AS r_assignee, random() AS r_priority, random() AS r_channel,
             random() AS r_contact, random() AS r_topic, random() AS r_object, random() AS r_deleted
      FROM generate_series(1, ${count}) g
    ),
    shaped AS (
      SELECT d.*,
        ${weighted(sql`d.r_state`, [
          [sql`'Closed'`, 0.7],
          [sql`'Open'`, 0.14],
          [sql`'Awaiting customer'`, 0.08],
          [sql`'Escalated'`, 0.03],
          [sql`'Spam'`, 0.03],
          [sql`'Merged'`, 0.02],
        ])} AS status_name
      FROM draws d
    )
    INSERT INTO tickets (
      id, brand_id, department_id, number, prefix, subject, status_id, priority, channel,
      assignee_id, contact_id, resolution_due_at, sla_breached, closed_at, deleted_at,
      created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      ${brand.brandId}::uuid,
      ${weighted(sql`s.r_department`, departmentIds)},
      -- From the brand's own sequence, as the api numbers a ticket, so one
      -- created during the run cannot collide with a seeded one.
      nextval(${brandTicketSequenceName(brand.brandId)}::regclass),
      ${prefix},
      (${textArray(TOPICS)})[1 + floor(s.r_topic * ${TOPICS.length})::int] || ' ' ||
        (${textArray(OBJECTS)})[1 + floor(s.r_object * ${OBJECTS.length})::int] || ' #' || (1000 + s.n),
      CASE s.status_name
        WHEN 'Closed' THEN ${status('Closed')}
        WHEN 'Open' THEN ${status('Open')}
        WHEN 'Awaiting customer' THEN ${status('Awaiting customer')}
        WHEN 'Escalated' THEN ${status('Escalated')}
        WHEN 'Spam' THEN ${status('Spam')}
        ELSE ${status('Merged')}
      END,
      ${weighted(sql`s.r_priority`, [
        [sql`'low'::ticket_priority`, 0.2],
        [sql`'medium'::ticket_priority`, 0.55],
        [sql`'high'::ticket_priority`, 0.2],
        [sql`'urgent'::ticket_priority`, 0.05],
      ])},
      ${weighted(sql`s.r_channel`, [
        [sql`'email'::ticket_channel`, 0.5],
        [sql`'chat'::ticket_channel`, 0.25],
        [sql`'telegram'::ticket_channel`, 0.1],
        [sql`'form'::ticket_channel`, 0.1],
        [sql`'manual'::ticket_channel`, 0.05],
      ])},
      -- A quarter of the live queue is unassigned; almost nothing closed is.
      CASE WHEN s.r_assignee < (CASE WHEN s.status_name IN ('Open', 'Awaiting customer', 'Escalated') THEN 0.25 ELSE 0.05 END)
           THEN NULL
           ELSE p.staff[1 + floor(s.r_assignee * array_length(p.staff, 1))::int]
      END,
      CASE WHEN s.r_contact < 0.95
           THEN p.contacts[1 + floor(s.r_contact / 0.95 * array_length(p.contacts, 1))::int]
      END,
      CASE WHEN s.status_name IN ('Open', 'Escalated') THEN now() + (s.r_age - 0.3) * interval '3 days' END,
      s.status_name IN ('Open', 'Escalated') AND s.r_age < 0.3,
      CASE WHEN s.status_name IN ('Closed', 'Spam', 'Merged') THEN now() - s.r_age * s.r_age * interval '730 days' END,
      CASE WHEN s.r_deleted < 0.005 THEN now() END,
      -- Closed work is spread over two years, weighted to the recent; the live
      -- queue moved in the last month.
      now() - (CASE WHEN s.status_name IN ('Closed', 'Spam', 'Merged')
                    THEN s.r_age * s.r_age * interval '730 days'
                    ELSE s.r_age * interval '30 days' END) - interval '2 days',
      now() - (CASE WHEN s.status_name IN ('Closed', 'Spam', 'Merged')
                    THEN s.r_age * s.r_age * interval '730 days'
                    ELSE s.r_age * interval '30 days' END)
    FROM shaped s CROSS JOIN people p
  `);
};

/**
 * `1 + number % (2n − 1)` messages per ticket: deterministic, and exactly `n`
 * on average over any run of `2n − 1` consecutive numbers. Odd seqs are the
 * customer, even ones the assignee, and one staff message in six is a note.
 */
const insertMessages = (tx: DbTransaction, messagesPerTicket: number) =>
  tx.execute(sql`
    INSERT INTO ticket_messages (
      id, brand_id, ticket_id, department_id, seq, kind, author_type, author_id,
      body_html, body_text, channel, created_at
    )
    SELECT gen_random_uuid(), t.brand_id, t.id, t.department_id, m.seq,
           CASE WHEN m.seq % 2 = 0 AND m.seq % 6 = 0 THEN 'note' ELSE 'public' END::ticket_message_kind,
           CASE WHEN m.seq % 2 = 1 THEN 'contact' ELSE 'staff' END::message_author_type,
           CASE WHEN m.seq % 2 = 1 THEN t.contact_id::text ELSE t.assignee_id::text END,
           '<p>' || t.subject || ' — message ' || m.seq || '</p>',
           t.subject || ' — message ' || m.seq,
           t.channel,
           t.created_at + m.seq * interval '1 hour'
    FROM tickets t
    CROSS JOIN LATERAL generate_series(1, 1 + (t.number % ${2 * messagesPerTicket - 1})::int) AS m(seq)
  `);

/**
 * 0–3 tags per ticket (35 % none), each drawn with `random()²` so the first
 * few tags are on thousands of tickets and the last few on dozens.
 */
const insertTicketTags = (tx: DbTransaction, tagIds: readonly string[]) =>
  tx.execute(sql`
    INSERT INTO ticket_tags (ticket_id, tag_id, brand_id, department_id)
    SELECT t.id,
           (${uuidArray(tagIds)})[1 + floor(power(random(), 2) * ${tagIds.length})::int],
           t.brand_id, t.department_id
    FROM tickets t
    CROSS JOIN LATERAL generate_series(1, (
      CASE WHEN abs(hashint8(t.number) % 100) < 35 THEN 0
           WHEN abs(hashint8(t.number) % 100) < 75 THEN 1
           WHEN abs(hashint8(t.number) % 100) < 93 THEN 2
           ELSE 3 END)) AS k
    ON CONFLICT DO NOTHING
  `);

const seedBrand = async (
  db: Db,
  shape: BrandShape,
  staff: readonly string[],
  log: (message: string) => void,
): Promise<SeededBrand> => {
  const [created] = await db
    .insert(brands)
    .values({ name: shape.name, prefix: shape.prefix })
    .returning({ id: brands.id });
  if (created === undefined) {
    throw new Error(`The brand ${shape.name} could not be created`);
  }
  const brandId = created.id;

  const brand = await withSystem(db, brandId, async (tx) => {
    await tx.execute(sql`SELECT setseed(${shape.seed})`);
    await seedBrandStatuses(tx, brandId);

    const departmentRows = await tx
      .insert(departments)
      .values(DEPARTMENTS.map(([name], sortOrder) => ({ brandId, name, sortOrder })))
      .returning({ id: departments.id, name: departments.name });

    const tagRows = await tx
      .insert(tags)
      .values(
        Array.from({ length: TAGS_PER_BRAND }, (_, index) => ({
          brandId,
          name: `tag-${String(index + 1).padStart(2, '0')}`,
          sortOrder: index,
        })),
      )
      .returning({ id: tags.id });

    const seeded: SeededBrand = {
      brandId,
      departmentIds: new Map(departmentRows.map((row) => [row.name, row.id])),
      staffIds: staff,
      tagIds: tagRows.map((row) => row.id),
    };

    await insertContacts(tx, brandId, shape.scale.contacts);
    await insertTickets(tx, seeded, shape.prefix, shape.scale.tickets, await statusIdsOf(tx));
    await insertMessages(tx, shape.scale.messagesPerTicket);
    await insertTicketTags(tx, seeded.tagIds);

    return seeded;
  });

  log(`Seeded ${shape.name}: ${shape.scale.tickets} tickets.`);
  return brand;
};

/**
 * Everything the benchmark reads. The caller runs `ANALYZE` afterwards, as the
 * owner: a planner looking at statistics from before the load plans for an
 * empty table, and the runtime role may not analyse tables it does not own.
 */
export const seedPerfDataset = async (
  db: Db,
  { measured, others, passwordHash, log = () => {} }: DatasetOptions,
): Promise<PerfDataset> => {
  const run = Date.now().toString(36);
  const staff = await db
    .insert(users)
    .values(
      Array.from({ length: STAFF_PER_BRAND }, (_, index) => ({
        email: `perf-${run}-${index}@helpdock.test`,
        name: `Perf staff ${index + 1}`,
        status: 'active' as const,
        // Only the two accounts the benchmark signs in as need a password.
        passwordHash: index < 2 ? passwordHash : null,
      })),
    )
    .returning({ id: users.id, email: users.email });

  const [admin, agent] = staff;
  if (admin === undefined || agent === undefined) {
    throw new Error('The perf staff could not be created');
  }
  const staffIds = staff.map((row) => row.id);

  const shapes: BrandShape[] = [
    { name: `Perf measured ${run}`, prefix: 'PM', scale: measured, seed: 0.14 },
    ...[1, 2, 3, 4].map((index) => ({
      name: `Perf other ${index} ${run}`,
      prefix: `PO${index}`,
      scale: others,
      seed: index / 10,
    })),
  ];

  const seeded: SeededBrand[] = [];
  for (const shape of shapes) {
    seeded.push(await seedBrand(db, shape, staffIds, log));
  }

  const [measuredBrand] = seeded;
  if (measuredBrand === undefined) {
    throw new Error('The measured brand was not seeded');
  }

  const agentDepartmentIds = AGENT_DEPARTMENTS.map(
    (name) => measuredBrand.departmentIds.get(name) ?? '',
  );

  await withSystem(db, measuredBrand.brandId, (tx) =>
    tx.insert(userBrandRoles).values(
      staff.map((row) => ({
        userId: row.id,
        brandId: measuredBrand.brandId,
        role: row.id === admin.id ? ('admin' as const) : ('agent' as const),
        departmentIds:
          row.id === admin.id
            ? null
            : row.id === agent.id
              ? agentDepartmentIds
              : [...measuredBrand.departmentIds.values()],
      })),
    ),
  );

  const [first, second] = measuredBrand.tagIds;
  if (first === undefined || second === undefined) {
    throw new Error('The measured brand has no tags');
  }

  return {
    brandId: measuredBrand.brandId,
    admin,
    agent,
    agentDepartmentIds,
    tagPair: [first, second],
  };
};

const FIRST_NAMES = [
  'Amira',
  'Omar',
  'Lina',
  'Karim',
  'Sara',
  'Youssef',
  'Maya',
  'Hadi',
  'Nour',
  'Rami',
  'Emma',
  'Liam',
  'Olivia',
  'Noah',
  'Ava',
  'Lucas',
  'Mia',
  'Leo',
  'Zoe',
  'Adam',
];

const LAST_NAMES = [
  'Haddad',
  'Khalil',
  'Nasser',
  'Saleh',
  'Mansour',
  'Farah',
  'Aziz',
  'Rahman',
  'Smith',
  'Garcia',
  'Müller',
  'Rossi',
  'Dubois',
  'Silva',
  'Novak',
  'Kowalski',
];
