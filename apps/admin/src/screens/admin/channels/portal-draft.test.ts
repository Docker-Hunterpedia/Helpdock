import type { CustomDomain, PortalSettings } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  draftOf,
  hasNoDepartment,
  isChanged,
  portalAddress,
  requestOf,
  toggled,
} from './portal-draft.js';

const A = '0190a0a0-0000-7000-8000-000000000001';
const B = '0190a0a0-0000-7000-8000-000000000002';

const stored = (overrides: Partial<PortalSettings> = {}): PortalSettings => ({
  enabled: false,
  newCustomers: false,
  departmentIds: 'all',
  ...overrides,
});

describe('the portal draft', () => {
  it('starts equal to what is stored, so Save is disabled', () => {
    expect(isChanged(draftOf(stored()), stored())).toBe(false);
    expect(
      isChanged(draftOf(stored({ departmentIds: [A, B] })), stored({ departmentIds: [B, A] })),
    ).toBe(false);
  });

  it.each([
    ['the portal switch', { enabled: true }],
    ['new customers', { newCustomers: true }],
    ['the scope', { scope: 'only' as const, departmentIds: [A] }],
  ])('sees a change of %s', (_name, change) => {
    expect(isChanged({ ...draftOf(stored()), ...change }, stored())).toBe(true);
  });

  it('sees a different list of departments, and ignores the list while "all" is chosen', () => {
    const only = stored({ departmentIds: [A] });
    expect(isChanged({ ...draftOf(only), departmentIds: [A, B] }, only)).toBe(true);
    expect(isChanged({ ...draftOf(stored()), departmentIds: [A] }, stored())).toBe(false);
  });

  it('refuses "only these" with nothing ticked, and only then', () => {
    expect(hasNoDepartment({ ...draftOf(stored()), scope: 'only' })).toBe(true);
    expect(hasNoDepartment({ ...draftOf(stored()), scope: 'only', departmentIds: [A] })).toBe(
      false,
    );
    expect(hasNoDepartment({ ...draftOf(stored()), scope: 'all' })).toBe(false);
  });

  it('builds the request the api takes', () => {
    expect(requestOf({ ...draftOf(stored()), enabled: true, departmentIds: [A] })).toEqual({
      enabled: true,
      newCustomers: false,
      departmentIds: 'all',
    });
    expect(
      requestOf({ enabled: true, newCustomers: true, scope: 'only', departmentIds: [A, B] }),
    ).toEqual({
      enabled: true,
      newCustomers: true,
      departmentIds: [A, B],
    });
  });

  it('ticks and unticks in the order chosen, without duplicates', () => {
    expect(toggled([A], B, true)).toEqual([A, B]);
    expect(toggled([A, B], A, true)).toEqual([A, B]);
    expect(toggled([A, B], A, false)).toEqual([B]);
  });
});

describe('portalAddress', () => {
  const domain = (name: string, state: CustomDomain['state'], primary: boolean): CustomDomain =>
    ({ domain: name, state, primary }) as CustomDomain;
  const fallback = { host: 'support.example.com', brandId: 'b1' };

  it('uses the primary verified domain, else the first verified one', () => {
    expect(
      portalAddress(
        [domain('a.example', 'verified', false), domain('b.example', 'verified', true)],
        fallback,
      ),
    ).toBe('b.example/tickets');
    expect(
      portalAddress(
        [domain('p.example', 'pending', true), domain('a.example', 'verified', false)],
        fallback,
      ),
    ).toBe('a.example/tickets');
  });

  it('falls back to the install address with the brand path when no domain is verified', () => {
    expect(portalAddress([], fallback)).toBe('support.example.com/hc/b1/tickets');
    expect(portalAddress([domain('p.example', 'failed', true)], fallback)).toBe(
      'support.example.com/hc/b1/tickets',
    );
  });
});
