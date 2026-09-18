import { describe, expect, it } from 'vitest';
import { SESSION_SETTINGS } from './rls.js';
import {
  INSTALL_SCOPE_BRAND_ID,
  systemContext,
  type TenantContext,
  TenantContextError,
  tenantSessionSettings,
} from './tenant.js';
import { uuidv7 } from './uuid.js';

const brandA = uuidv7();
const brandB = uuidv7();
const departmentA = uuidv7();

const context = (overrides: Partial<TenantContext> = {}): TenantContext => ({
  brandIds: [brandA],
  departmentIds: 'all',
  principalType: 'staff',
  principalId: uuidv7(),
  ...overrides,
});

const settingsOf = (ctx: TenantContext): Record<string, string> =>
  Object.fromEntries(tenantSessionSettings(ctx));

describe('tenantSessionSettings', () => {
  it('sets the five settings the policies read', () => {
    expect(Object.keys(settingsOf(context()))).toEqual(Object.values(SESSION_SETTINGS));
  });

  it('writes brand ids as a Postgres array literal', () => {
    const settings = settingsOf(context({ brandIds: [brandA, brandB] }));

    expect(settings[SESSION_SETTINGS.brandIds]).toBe(`{${brandA},${brandB}}`);
  });

  it('turns "all departments" into the flag and an empty list', () => {
    const settings = settingsOf(context({ departmentIds: 'all' }));

    expect(settings[SESSION_SETTINGS.allDepartments]).toBe('true');
    expect(settings[SESSION_SETTINGS.departmentIds]).toBe('{}');
  });

  it('keeps a restricted department list and clears the flag', () => {
    const settings = settingsOf(context({ departmentIds: [departmentA] }));

    expect(settings[SESSION_SETTINGS.allDepartments]).toBe('false');
    expect(settings[SESSION_SETTINGS.departmentIds]).toBe(`{${departmentA}}`);
  });

  it('passes the principal through for the audit trail', () => {
    const settings = settingsOf(
      context({ principalType: 'apikey', principalId: 'job:outbox.relay-42' }),
    );

    expect(settings[SESSION_SETTINGS.principalType]).toBe('apikey');
    expect(settings[SESSION_SETTINGS.principalId]).toBe('job:outbox.relay-42');
  });

  it.each(["6f8b1c0e-0000-7000-8000-000000000000'}, (select 1) --", 'not-a-uuid', '', '*'])(
    'refuses %s as a brand id',
    (brandId) => {
      expect(() => tenantSessionSettings(context({ brandIds: [brandId] }))).toThrow(
        TenantContextError,
      );
    },
  );

  it('refuses a department id that is not a uuid', () => {
    expect(() => tenantSessionSettings(context({ departmentIds: ['all'] }))).toThrow(
      TenantContextError,
    );
  });

  it('refuses a context with no brand, which could only ever read nothing', () => {
    expect(() => tenantSessionSettings(context({ brandIds: [] }))).toThrow(TenantContextError);
  });

  it('refuses a principal type outside DOMAIN-RULES §1.1', () => {
    // A value the type system rules out still reaches this function from JSON.
    const ctx = context({ principalType: 'root' as TenantContext['principalType'] });

    expect(() => tenantSessionSettings(ctx)).toThrow(TenantContextError);
  });

  it.each(['', 'job id with spaces', 'x'.repeat(129), "1'; set role postgres; --"])(
    'refuses %s as a principal id',
    (principalId) => {
      expect(() => tenantSessionSettings(context({ principalId }))).toThrow(TenantContextError);
    },
  );

  it('names the field at fault and not its value', () => {
    try {
      tenantSessionSettings(context({ brandIds: ['secret-looking-value'] }));
      expect.unreachable('the context should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantContextError);
      expect((error as TenantContextError).field).toBe('brandIds');
      expect((error as TenantContextError).message).not.toContain('secret-looking-value');
    }
  });
});

describe('systemContext', () => {
  it('is one brand, every department, as DOMAIN-RULES §1.4 requires', () => {
    const settings = settingsOf(systemContext(brandA));

    expect(settings[SESSION_SETTINGS.brandIds]).toBe(`{${brandA}}`);
    expect(settings[SESSION_SETTINGS.allDepartments]).toBe('true');
    expect(settings[SESSION_SETTINGS.principalType]).toBe('system');
  });

  it('records the job id when the caller has one', () => {
    expect(settingsOf(systemContext(brandA, 'outbox.relay:91'))[SESSION_SETTINGS.principalId]).toBe(
      'outbox.relay:91',
    );
  });
});

describe('INSTALL_SCOPE_BRAND_ID', () => {
  it('is a uuid, so it passes the same validation as a real brand', () => {
    expect(() => tenantSessionSettings(systemContext(INSTALL_SCOPE_BRAND_ID))).not.toThrow();
  });
});
