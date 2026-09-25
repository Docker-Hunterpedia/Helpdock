import { and, eq, sql } from 'drizzle-orm';
import type { DbTransaction } from './client.js';
import { departments } from './schema/departments.js';
import { views } from './schema/views.js';

/**
 * The default views every brand starts with (REQUIREMENTS §4.1, M1-05): My
 * open, Unassigned, Overdue, Escalated, and one "All open" per department.
 *
 * They are rows rather than code so that a brand can rename, reorder and hide
 * them like any other shared view; the `built_in` key is what stops them being
 * deleted or refiltered. Their filters are written in the ticket list's own
 * vocabulary (`ticketViewFiltersSchema`), with `me` for the reader, so one
 * shared "My open" means *mine* to everybody who opens it.
 *
 * "Live" is every state but closed: what "open" means to a person at a desk.
 */

const LIVE_STATES = ['open', 'on_hold', 'escalated'] as const;
const DEFAULT_ORDER = { sort: 'updatedAt', direction: 'desc' } as const;

export const BUILT_IN_BRAND_VIEWS = [
  {
    builtIn: 'my_open',
    name: 'My open',
    nameAr: 'المفتوحة لديّ',
    sortOrder: 0,
    filters: { assigneeId: ['me'], systemState: [...LIVE_STATES], ...DEFAULT_ORDER },
  },
  {
    builtIn: 'unassigned',
    name: 'Unassigned',
    nameAr: 'غير المسندة',
    sortOrder: 1,
    filters: { assigneeId: ['unassigned'], systemState: [...LIVE_STATES], ...DEFAULT_ORDER },
  },
  {
    builtIn: 'overdue',
    name: 'Overdue',
    nameAr: 'المتأخرة',
    sortOrder: 2,
    filters: { overdue: true, systemState: [...LIVE_STATES], ...DEFAULT_ORDER },
  },
  {
    builtIn: 'escalated',
    name: 'Escalated',
    nameAr: 'المُصعَّدة',
    // After every department's "All open", which take the places between.
    sortOrder: 1000,
    filters: { systemState: ['escalated'], ...DEFAULT_ORDER },
  },
] as const;

/** Where the per-department views start: after the three brand-wide ones above them. */
const DEPARTMENT_VIEW_ORDER = 3;

/** The default name of a department's "All open" view, in both languages. */
export const departmentViewName = (department: {
  readonly name: string;
  readonly nameAr: string | null;
}): { readonly name: string; readonly nameAr: string } => ({
  name: `All open · ${department.name}`,
  nameAr: `كل المفتوحة · ${department.nameAr ?? department.name}`,
});

const departmentViewFilters = (departmentId: string) => ({
  departmentId: [departmentId],
  systemState: [...LIVE_STATES],
  ...DEFAULT_ORDER,
});

/**
 * Writes whichever defaults the brand is missing, through the caller's
 * transaction: the four brand-wide ones and an "All open" for every department
 * that has none. Idempotent on the unique `(brand, built_in, department)`
 * index, so it is safe to call after a brand is created, after a department is
 * created, and on a brand that predates M1-05.
 *
 * A department's view is shared with that department, which is who works it.
 * Deleting the department deletes the view through the foreign key.
 */
export const seedBrandViews = async (tx: DbTransaction, brandId: string): Promise<void> => {
  await tx
    .insert(views)
    .values(
      BUILT_IN_BRAND_VIEWS.map((view) => ({
        brandId,
        builtIn: view.builtIn,
        name: view.name,
        nameAr: view.nameAr,
        sortOrder: view.sortOrder,
        filters: view.filters,
      })),
    )
    .onConflictDoNothing();

  const missing = await tx
    .select({
      id: departments.id,
      name: departments.name,
      nameAr: departments.nameAr,
      sortOrder: departments.sortOrder,
    })
    .from(departments)
    .where(
      and(
        eq(departments.brandId, brandId),
        sql`NOT EXISTS (SELECT 1 FROM ${views} WHERE ${views.departmentId} = ${departments.id} AND ${views.builtIn} = 'department_open')`,
      ),
    );

  if (missing.length === 0) {
    return;
  }

  await tx
    .insert(views)
    .values(
      missing.map((department) => ({
        brandId,
        builtIn: 'department_open' as const,
        departmentId: department.id,
        ...departmentViewName(department),
        visibleDepartmentIds: [department.id],
        sortOrder: DEPARTMENT_VIEW_ORDER + department.sortOrder,
        filters: departmentViewFilters(department.id),
      })),
    )
    .onConflictDoNothing();
};

/**
 * Keeps a department's "All open" view named after it when the department is
 * renamed — unless the brand has renamed the view itself, which is a choice to
 * keep. Each language is compared on its own, so renaming one leaves the other
 * following the department.
 */
export const renameDepartmentView = async (
  tx: DbTransaction,
  departmentId: string,
  previous: { readonly name: string; readonly nameAr: string | null },
  next: { readonly name: string; readonly nameAr: string | null },
): Promise<void> => {
  const before = departmentViewName(previous);
  const after = departmentViewName(next);
  const theView = and(eq(views.departmentId, departmentId), eq(views.builtIn, 'department_open'));

  await tx
    .update(views)
    .set({ name: after.name })
    .where(and(theView, eq(views.name, before.name)));
  await tx
    .update(views)
    .set({ nameAr: after.nameAr })
    .where(and(theView, eq(views.nameAr, before.nameAr)));
};
