import { describe, expect, it } from 'vitest';
import {
  brandCreateRequestSchema,
  departmentCreateRequestSchema,
  departmentListSchema,
  departmentReorderRequestSchema,
  departmentSummarySchema,
  departmentUpdateRequestSchema,
  teamCreateRequestSchema,
  teamSchema,
} from './ticketing.js';

const DEPARTMENT = '01937f5e-7e53-7000-8000-00000000000b';
const TEAM = '01937f5e-7e53-7000-8000-00000000000c';
const USER = '01937f5e-7e53-7000-8000-00000000000d';

const summary = {
  id: DEPARTMENT,
  name: 'Billing',
  nameAr: 'الفوترة',
  sortOrder: 0,
  defaultTeamId: null,
  defaultTeamName: null,
  teamCount: 2,
  memberCount: 5,
};

describe('departmentSummarySchema', () => {
  it('still parses as the small shape the staff screens read', () => {
    // The staff chip picker parses the same response with the narrower schema,
    // so widening the endpoint must not break it.
    const parsed = departmentListSchema.parse({ departments: [summary] });

    expect(parsed.departments[0]).toEqual({ id: DEPARTMENT, name: 'Billing' });
  });

  it('allows a department with no Arabic name and no default team', () => {
    const parsed = departmentSummarySchema.parse({
      ...summary,
      nameAr: null,
      defaultTeamId: null,
    });

    expect(parsed.nameAr).toBeNull();
  });

  it('refuses a negative position', () => {
    expect(departmentSummarySchema.safeParse({ ...summary, sortOrder: -1 }).success).toBe(false);
  });
});

describe('departmentCreateRequestSchema', () => {
  it('trims the name so two departments cannot differ by a space', () => {
    expect(departmentCreateRequestSchema.parse({ name: '  Billing ' }).name).toBe('Billing');
  });

  it('refuses an empty name', () => {
    expect(departmentCreateRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('treats a missing Arabic name and an explicit null the same way', () => {
    expect(departmentCreateRequestSchema.parse({ name: 'Billing' }).nameAr).toBeUndefined();
    expect(
      departmentCreateRequestSchema.parse({ name: 'Billing', nameAr: null }).nameAr,
    ).toBeNull();
  });
});

describe('departmentUpdateRequestSchema', () => {
  it('refuses a body that changes nothing', () => {
    expect(departmentUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('lets the default team be cleared', () => {
    expect(departmentUpdateRequestSchema.parse({ defaultTeamId: null }).defaultTeamId).toBeNull();
  });

  it('refuses a default team that is not a uuid', () => {
    expect(departmentUpdateRequestSchema.safeParse({ defaultTeamId: 'none' }).success).toBe(false);
  });
});

describe('departmentReorderRequestSchema', () => {
  it('refuses an empty order, which would say nothing', () => {
    expect(departmentReorderRequestSchema.safeParse({ departmentIds: [] }).success).toBe(false);
  });

  it('accepts the whole list in its new order', () => {
    expect(
      departmentReorderRequestSchema.parse({ departmentIds: [DEPARTMENT, TEAM] }).departmentIds,
    ).toEqual([DEPARTMENT, TEAM]);
  });
});

describe('teamSchema', () => {
  it('never carries an address: the team list is readable at brand:read', () => {
    const parsed = teamSchema.parse({
      id: TEAM,
      departmentId: DEPARTMENT,
      name: 'Front line',
      sortOrder: 0,
      members: [{ userId: USER, name: 'Lina', email: 'lina@example.com', role: 'agent' }],
    });

    expect(parsed.members[0]).not.toHaveProperty('email');
  });

  it('carries its members so a department renders in one round trip', () => {
    const parsed = teamSchema.parse({
      id: TEAM,
      departmentId: DEPARTMENT,
      name: 'Front line',
      sortOrder: 0,
      members: [{ userId: USER, name: 'Lina', role: 'agent' }],
    });

    expect(parsed.members).toHaveLength(1);
  });

  it('refuses a role outside the four in DOMAIN-RULES §1.2', () => {
    const parsed = teamSchema.safeParse({
      id: TEAM,
      departmentId: DEPARTMENT,
      name: 'Front line',
      sortOrder: 0,
      members: [{ userId: USER, name: 'Lina', role: 'owner' }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('teamCreateRequestSchema', () => {
  it('refuses a blank name', () => {
    expect(teamCreateRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
  });
});

describe('brandCreateRequestSchema', () => {
  const brand = {
    name: 'Globex',
    prefix: 'GLBX',
    defaultLocale: 'en',
    timezone: 'Europe/London',
  };

  it('defaults the first department so a new brand is never an empty picker', () => {
    expect(brandCreateRequestSchema.parse(brand).firstDepartmentName).toBe('General');
  });

  it('applies the wizard’s own prefix rule rather than a second one', () => {
    expect(brandCreateRequestSchema.safeParse({ ...brand, prefix: 'lower' }).success).toBe(false);
    expect(brandCreateRequestSchema.safeParse({ ...brand, prefix: 'A' }).success).toBe(false);
  });

  it('refuses a time zone that is not an IANA name', () => {
    expect(brandCreateRequestSchema.safeParse({ ...brand, timezone: 'Mars/Olympus' }).success).toBe(
      false,
    );
  });
});
