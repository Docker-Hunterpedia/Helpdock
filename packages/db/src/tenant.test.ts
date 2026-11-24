import { describe, expect, it } from 'vitest';
import type { DbTransaction } from './client.js';
import { SESSION_SETTINGS } from './rls.js';
import {
  cleanIp,
  currentDepartmentScope,
  customerContext,
  INSTALL_SCOPE_BRAND_ID,
  REQUEST_SETTINGS,
  systemContext,
  type TenantContext,
  TenantContextError,
  tenantSessionSettings,
} from './tenant.js';
import { uuidv7 } from './uuid.js';

const brandA = uuidv7();
const brandB = uuidv7();
const departmentA = uuidv7();
const departmentB = uuidv7();

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
  describe('with the request it serves (M3-08)', () => {
    const request = { requestId: 'req-1', ip: '10.0.4.17', userAgent: 'Firefox/130' };

    it('adds the three settings the audit columns default to', () => {
      const settings = settingsOf(context({ request }));

      expect(settings[REQUEST_SETTINGS.requestId]).toBe('req-1');
      expect(settings[REQUEST_SETTINGS.ip]).toBe('10.0.4.17');
      expect(settings[REQUEST_SETTINGS.userAgent]).toBe('Firefox/130');
    });

    it('drops an address Postgres would refuse, rather than failing the audit insert', () => {
      const settings = settingsOf(context({ request: { ...request, ip: '10.0.4.17, 1.2.3.4' } }));

      expect(settings[REQUEST_SETTINGS.ip]).toBe('');
    });

    it('keeps the user agent printable and short', () => {
      const settings = settingsOf(
        context({ request: { ...request, userAgent: `bad\u0000${'x'.repeat(400)}` } }),
      );

      expect(settings[REQUEST_SETTINGS.userAgent]).toMatch(/^badx+$/);
      expect(settings[REQUEST_SETTINGS.userAgent]).toHaveLength(256);
    });

    it('sets nothing about a request when there is none', () => {
      expect(Object.keys(settingsOf(context()))).not.toContain(REQUEST_SETTINGS.ip);
    });
  });

  it('sets the five settings every policy reads, and none of the customer ones, for any other principal', () => {
    expect(Object.keys(settingsOf(context()))).toEqual([
      SESSION_SETTINGS.brandIds,
      SESSION_SETTINGS.departmentIds,
      SESSION_SETTINGS.allDepartments,
      SESSION_SETTINGS.principalType,
      SESSION_SETTINGS.principalId,
    ]);
  });

  describe('for a customer (M21-01)', () => {
    const contactId = uuidv7();
    const accountId = uuidv7();
    const customer = (
      overrides: Partial<TenantContext> & { facts?: TenantContext['customer'] } = {},
    ): TenantContext =>
      context({
        principalType: 'customer',
        principalId: contactId,
        customer: { contactId, accountId, sees: 'account' },
        departmentIds: [departmentA],
        ...overrides,
      });

    it('adds the contact, the account and what they see to the five', () => {
      const settings = settingsOf(customer());

      expect(settings[SESSION_SETTINGS.principalType]).toBe('customer');
      expect(settings[SESSION_SETTINGS.customerContactId]).toBe(contactId);
      expect(settings[SESSION_SETTINGS.customerAccountId]).toBe(accountId);
      expect(settings[SESSION_SETTINGS.customerSees]).toBe('account');
      expect(settings[SESSION_SETTINGS.departmentIds]).toBe(`{${departmentA}}`);
    });

    it('writes no account as an empty string, which the policy reads as null', () => {
      const settings = settingsOf(
        customer({ customer: { contactId, accountId: null, sees: 'own' } }),
      );

      expect(settings[SESSION_SETTINGS.customerAccountId]).toBe('');
      expect(settings[SESSION_SETTINGS.customerSees]).toBe('own');
    });

    it('refuses a customer with no facts', () => {
      expect(() => tenantSessionSettings(customer({ customer: undefined }))).toThrow(
        TenantContextError,
      );
    });

    it("refuses facts on any other principal, so nobody borrows a customer's reach", () => {
      for (const principalType of ['staff', 'visitor', 'apikey', 'system'] as const) {
        expect(() =>
          tenantSessionSettings(
            context({ principalType, customer: { contactId, accountId: null, sees: 'own' } }),
          ),
        ).toThrow(TenantContextError);
      }
    });

    it('refuses a contact that is not the principal', () => {
      expect(() =>
        tenantSessionSettings(
          customer({ customer: { contactId: uuidv7(), accountId, sees: 'account' } }),
        ),
      ).toThrow(TenantContextError);
    });

    it.each([
      ['a contact id that is not a uuid', { contactId: 'me', accountId: null, sees: 'own' }],
      ['an account id that is not a uuid', { contactId, accountId: 'acme', sees: 'own' }],
      ['a reach outside own and account', { contactId, accountId, sees: 'brand' }],
    ])('refuses %s', (_name, facts) => {
      expect(() =>
        tenantSessionSettings(
          customer({
            principalId: facts.contactId,
            customer: facts as NonNullable<TenantContext['customer']>,
          }),
        ),
      ).toThrow(TenantContextError);
    });

    it('refuses a customer that names more than one brand', () => {
      expect(() => tenantSessionSettings(customer({ brandIds: [brandA, brandB] }))).toThrow(
        TenantContextError,
      );
    });

    it('builds the context from customerContext', () => {
      const built = customerContext({
        brandId: brandA,
        contactId,
        accountId,
        sees: 'own',
        departmentIds: 'all',
      });

      expect(built).toMatchObject({
        brandIds: [brandA],
        principalType: 'customer',
        principalId: contactId,
        departmentIds: 'all',
        customer: { contactId, accountId, sees: 'own' },
      });
    });
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

describe('currentDepartmentScope', () => {
  /** Answers whatever `current_setting` would; nothing else is queried. */
  const txReturning = (row: Record<string, string | null>) =>
    ({ execute: () => Promise.resolve([row]) }) as unknown as DbTransaction;

  it('reads an unrestricted scope as `all`', async () => {
    await expect(
      currentDepartmentScope(txReturning({ all_departments: 'true', department_ids: '{}' })),
    ).resolves.toBe('all');
  });

  it('reads the explicit list the transaction carries', async () => {
    await expect(
      currentDepartmentScope(
        txReturning({
          all_departments: 'false',
          department_ids: `{${departmentA},${departmentB}}`,
        }),
      ),
    ).resolves.toEqual([departmentA, departmentB]);
  });

  it('reads an empty list as no departments, which is what an Agent with none has', async () => {
    await expect(
      currentDepartmentScope(txReturning({ all_departments: 'false', department_ids: '{}' })),
    ).resolves.toEqual([]);
  });

  it('answers nothing outside a tenant transaction, as the policies do', async () => {
    // `current_setting(…, true)` is null when the setting was never set, and
    // the failure mode has to be "nothing", never "everything".
    await expect(
      currentDepartmentScope(txReturning({ all_departments: null, department_ids: null })),
    ).resolves.toEqual([]);
  });
});

describe('cleanIp', () => {
  it.each([
    ['10.0.4.17', '10.0.4.17'],
    ['::1', '::1'],
    ['::ffff:10.0.0.1', '::ffff:10.0.0.1'],
    ['fe80::1%eth0', 'fe80::1'],
    [' 34.201.18.7 ', '34.201.18.7'],
  ])('keeps %s as %s', (value, expected) => {
    expect(cleanIp(value)).toBe(expected);
  });

  it.each(['', 'localhost', '999.1.1.1', "1.2.3.4'; DROP TABLE x", null, undefined])(
    'drops %s',
    (value) => {
      expect(cleanIp(value)).toBeNull();
    },
  );
});
