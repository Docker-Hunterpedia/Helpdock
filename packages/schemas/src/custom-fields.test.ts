import { describe, expect, it } from 'vitest';
import {
  type CustomFieldDef,
  type CustomFieldRule,
  customFieldCreateRequestSchema,
  customFieldKeySchema,
  customFieldUpdateRequestSchema,
  customValuesSchema,
  isHttpsUrl,
  mergeCustomValues,
  missingRequiredToClose,
  type RequiredToCloseRule,
  visibleCustomValues,
} from './custom-fields.js';

const rule = (over: Partial<CustomFieldRule>): CustomFieldRule => ({
  key: 'plan',
  type: 'text',
  options: [],
  required: false,
  ...over,
});

/** What the schema makes of one value, or the string `failed`. */
const parse = (rules: readonly CustomFieldRule[], input: unknown, partial = false): unknown => {
  const result = customValuesSchema(rules, { partial }).safeParse(input);

  return result.success ? result.data : 'failed';
};

describe('customFieldKeySchema', () => {
  it.each(['plan', 'renewal_date', 'a1'])('accepts %s', (key) => {
    expect(customFieldKeySchema.parse(key)).toBe(key);
  });

  it.each(['Plan', '1plan', 'renewal-date', 'renewal date', '', '_plan'])(
    'refuses %s, because a key is also a column name in an export and an identifier in a rule',
    (key) => {
      expect(customFieldKeySchema.safeParse(key).success).toBe(false);
    },
  );
});

describe('customValuesSchema', () => {
  it('refuses a key no definition names, rather than dropping it', () => {
    // Silently ignoring it is the failure that matters: somebody believes they
    // saved a value that was never stored.
    expect(parse([rule({})], { plan: 'gold', mystery: 1 })).toBe('failed');
  });

  it('accepts an empty object when nothing is required', () => {
    expect(parse([rule({})], {})).toEqual({});
  });

  describe('text', () => {
    it('trims what it stores', () => {
      expect(parse([rule({})], { plan: '  gold  ' })).toEqual({ plan: 'gold' });
    });

    it('refuses a field of spaces, which is not an answer', () => {
      expect(parse([rule({})], { plan: '   ' })).toBe('failed');
    });
  });

  describe('number', () => {
    const rules = [rule({ key: 'seats', type: 'number' })];

    it('accepts a number', () => {
      expect(parse(rules, { seats: 12 })).toEqual({ seats: 12 });
    });

    it('accepts the string a form field holds, and stores a number', () => {
      expect(parse(rules, { seats: '12.5' })).toEqual({ seats: 12.5 });
    });

    it.each([true, [], {}, 'twelve', Number.POSITIVE_INFINITY])(
      'refuses %s rather than coercing it',
      (value) => {
        // `z.coerce.number()` would turn `true` into 1 and `[]` into 0, which is
        // how a checkbox ticked in the wrong field becomes the number one.
        expect(parse(rules, { seats: value })).toBe('failed');
      },
    );

    it('keeps null, which is how an optional field is cleared', () => {
      expect(parse(rules, { seats: null })).toEqual({ seats: null });
    });
  });

  describe('date', () => {
    const rules = [rule({ key: 'renews_on', type: 'date' })];

    it('accepts an ISO day', () => {
      expect(parse(rules, { renews_on: '2026-03-01' })).toEqual({ renews_on: '2026-03-01' });
    });

    it('cuts a date-time down to the day, so two equal days compare equal', () => {
      expect(parse(rules, { renews_on: '2026-03-01T13:45:00Z' })).toEqual({
        renews_on: '2026-03-01',
      });
    });

    it.each(['01/03/2026', '2026-13-01', 'tomorrow', 1_772_000_000])('refuses %s', (value) => {
      expect(parse(rules, { renews_on: value })).toBe('failed');
    });
  });

  describe('select', () => {
    const rules = [rule({ key: 'tier', type: 'select', options: ['gold', 'silver'] })];

    it('accepts one of the options', () => {
      expect(parse(rules, { tier: 'gold' })).toEqual({ tier: 'gold' });
    });

    it('refuses anything else', () => {
      expect(parse(rules, { tier: 'bronze' })).toBe('failed');
    });

    it('refuses everything when the definition has no options left', () => {
      expect(parse([rule({ key: 'tier', type: 'select' })], { tier: 'gold' })).toBe('failed');
    });
  });

  describe('multi_select', () => {
    const rules = [rule({ key: 'addons', type: 'multi_select', options: ['sso', 'sla', 'hsm'] })];

    it('accepts a subset', () => {
      expect(parse(rules, { addons: ['sso', 'sla'] })).toEqual({ addons: ['sso', 'sla'] });
    });

    it('accepts an empty list, which is "none of them"', () => {
      expect(parse(rules, { addons: [] })).toEqual({ addons: [] });
    });

    it('refuses an option that is not on the list', () => {
      expect(parse(rules, { addons: ['sso', 'gold'] })).toBe('failed');
    });

    it('refuses the same option twice, which is still one choice', () => {
      expect(parse(rules, { addons: ['sso', 'sso'] })).toBe('failed');
    });

    it('refuses a bare string, because a set of one is still a set', () => {
      expect(parse(rules, { addons: 'sso' })).toBe('failed');
    });
  });

  describe('checkbox', () => {
    const rules = [rule({ key: 'vip', type: 'checkbox' })];

    it('accepts a boolean', () => {
      expect(parse(rules, { vip: true })).toEqual({ vip: true });
    });

    it.each(['true', 1, 'yes'])('refuses %s, so a ticked box is never a guess', (value) => {
      expect(parse(rules, { vip: value })).toBe('failed');
    });
  });

  describe('long_text (M14-27)', () => {
    const rules = [rule({ key: 'notes', type: 'long_text' })];

    it('trims, and keeps the line breaks inside', () => {
      expect(parse(rules, { notes: '  one\ntwo  ' })).toEqual({ notes: 'one\ntwo' });
    });

    it('takes 5,000 characters and refuses 5,001', () => {
      expect(parse(rules, { notes: 'x'.repeat(5000) })).toEqual({ notes: 'x'.repeat(5000) });
      expect(parse(rules, { notes: 'x'.repeat(5001) })).toBe('failed');
    });

    it('refuses spaces, which are not an answer', () => {
      expect(parse(rules, { notes: '  ' })).toBe('failed');
    });
  });

  describe('link (M14-27)', () => {
    const rules = [rule({ key: 'page', type: 'link' })];

    it('accepts an https address, trimmed', () => {
      expect(parse(rules, { page: ' https://status.stripe.com/incidents/42 ' })).toEqual({
        page: 'https://status.stripe.com/incidents/42',
      });
    });

    it.each([
      'http://example.com',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      '//example.com',
      'example.com',
      'https://user:pass@example.com',
      'https://',
      '',
    ])('refuses %s, because the value is put in an href', (page) => {
      expect(parse(rules, { page })).toBe('failed');
    });

    it('refuses an address over 2,000 characters', () => {
      expect(parse(rules, { page: `https://example.com/${'a'.repeat(1990)}` })).toBe('failed');
    });
  });

  describe('email (M14-27)', () => {
    const rules = [rule({ key: 'billing', type: 'email' })];

    it('stores a trimmed, lower-cased address', () => {
      expect(parse(rules, { billing: ' Finance@Globex.COM ' })).toEqual({
        billing: 'finance@globex.com',
      });
    });

    it.each(['finance', 'a@', '@b.co', 'a b@c.co', ''])('refuses %s', (billing) => {
      expect(parse(rules, { billing })).toBe('failed');
    });
  });

  describe('person (M14-27)', () => {
    const rules = [rule({ key: 'owner', type: 'person' })];
    const id = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

    it('accepts an id; whether it is staff of the brand is the api’s to check', () => {
      expect(parse(rules, { owner: id })).toEqual({ owner: id });
    });

    it.each(['Sam', '', 12, true])('refuses %s, which is not an id', (owner) => {
      expect(parse(rules, { owner })).toBe('failed');
    });
  });

  describe('bidi controls (M14-27)', () => {
    it('strips them from a link, an email and a long text on write', () => {
      const rules = [
        rule({ key: 'page', type: 'link' }),
        rule({ key: 'billing', type: 'email' }),
        rule({ key: 'notes', type: 'long_text' }),
      ];

      expect(
        parse(rules, {
          page: 'https://\u202Eexample.com/a\u2066',
          billing: 'a\u202E@b.co',
          notes: 'x\u2067y\u202Cz',
        }),
      ).toEqual({ page: 'https://example.com/a', billing: 'a@b.co', notes: 'xyz' });
    });
  });

  describe('isHttpsUrl', () => {
    it('is true for https and for nothing else', () => {
      expect(isHttpsUrl('https://example.com')).toBe(true);
      expect(isHttpsUrl('http://example.com')).toBe(false);
      expect(isHttpsUrl('not a url')).toBe(false);
    });
  });

  describe('required', () => {
    const rules = [rule({ required: true })];

    it('is enforced on a create', () => {
      expect(parse(rules, {})).toBe('failed');
    });

    it('refuses null on a create, because clearing is not filling in', () => {
      expect(parse(rules, { plan: null })).toBe('failed');
    });

    it('is not enforced on a patch, which says nothing about what it omits', () => {
      expect(parse(rules, {}, true)).toEqual({});
    });

    it('lets a patch clear it with null', () => {
      expect(parse(rules, { plan: null }, true)).toEqual({ plan: null });
    });
  });
});

describe('mergeCustomValues', () => {
  it('writes the patch over what is stored', () => {
    expect(mergeCustomValues({ plan: 'gold', seats: 3 }, { seats: 5 })).toEqual({
      plan: 'gold',
      seats: 5,
    });
  });

  it('removes a key the patch set to null rather than storing one', () => {
    // Two representations of "unset" would mean every reader had to know both.
    expect(mergeCustomValues({ plan: 'gold' }, { plan: null })).toEqual({});
  });

  it('leaves the stored object alone', () => {
    const stored = { plan: 'gold' };
    mergeCustomValues(stored, { plan: 'silver' });

    expect(stored).toEqual({ plan: 'gold' });
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'makes %s an ordinary entry rather than a prototype',
    (key) => {
      // `customFieldKeySchema` already refuses these, but this function is
      // exported from a package and "safe because of who calls it" is not safe.
      const merged = mergeCustomValues({}, JSON.parse(`{"${key}": {"polluted": true}}`));

      expect(Object.hasOwn(merged, key)).toBe(true);
      expect({}).not.toHaveProperty('polluted');
      expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    },
  );
});

describe('visibleCustomValues', () => {
  const def = (key: string): CustomFieldDef => ({
    id: '01937f5e-7e53-7000-8000-000000000001',
    target: 'ticket',
    key,
    label: key,
    labelAr: null,
    type: 'text',
    options: [],
    required: false,
    requiredToClose: false,
    agentVisible: true,
    pinned: false,
    sortOrder: 0,
  });

  it('drops a key whose definition has been deleted', () => {
    // Deleting a definition does not rewrite every row that used it, so reads
    // filter rather than trusting what is stored.
    expect(visibleCustomValues({ plan: 'gold', gone: 'x' }, [def('plan')])).toEqual({
      plan: 'gold',
    });
  });

  it('cannot be made to set a prototype by a key in the stored column', () => {
    const stored = JSON.parse('{"__proto__": {"polluted": true}, "plan": "gold"}') as Record<
      string,
      unknown
    >;

    const visible = visibleCustomValues(stored, [def('plan')]);

    expect(visible).toEqual({ plan: 'gold' });
    expect({}).not.toHaveProperty('polluted');
  });
});

describe('customFieldCreateRequestSchema', () => {
  const valid = { target: 'ticket', key: 'tier', label: 'Tier', type: 'text' };

  it('defaults the flags a brand rarely sets', () => {
    expect(customFieldCreateRequestSchema.parse(valid)).toMatchObject({
      options: [],
      required: false,
      requiredToClose: false,
      agentVisible: true,
      pinned: false,
    });
  });

  it('pins a field only when asked to, and an update may pin or unpin one (M14-16)', () => {
    expect(customFieldCreateRequestSchema.parse({ ...valid, pinned: true }).pinned).toBe(true);
    expect(customFieldUpdateRequestSchema.parse({ pinned: true }).pinned).toBe(true);
    expect(customFieldUpdateRequestSchema.parse({ pinned: false }).pinned).toBe(false);
    expect(customFieldUpdateRequestSchema.safeParse({ force: true }).success).toBe(false);
  });

  it.each(['contact', 'account'])('refuses requiredToClose on a %s field', (target) => {
    const result = customFieldCreateRequestSchema.safeParse({
      ...valid,
      target,
      requiredToClose: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['requiredToClose'],
      message: 'Only ticket fields can be required to close',
    });
  });

  it('refuses requiredToClose on a field agents cannot see, which no agent could fill in', () => {
    const result = customFieldCreateRequestSchema.safeParse({
      ...valid,
      requiredToClose: true,
      agentVisible: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['agentVisible']);
  });

  it('accepts requiredToClose on a visible ticket field, and a hidden one that is not gated', () => {
    expect(
      customFieldCreateRequestSchema.safeParse({ ...valid, requiredToClose: true }).success,
    ).toBe(true);
    expect(
      customFieldCreateRequestSchema.safeParse({ ...valid, agentVisible: false }).success,
    ).toBe(true);
  });

  it('refuses a select with no options, which would show an empty menu', () => {
    expect(
      customFieldCreateRequestSchema.safeParse({ ...valid, type: 'select', options: [] }).success,
    ).toBe(false);
  });

  it('refuses options on a type that has no choices, because nothing would read them', () => {
    expect(
      customFieldCreateRequestSchema.safeParse({ ...valid, type: 'text', options: ['a'] }).success,
    ).toBe(false);
  });

  it('refuses two identical options', () => {
    expect(
      customFieldCreateRequestSchema.safeParse({
        ...valid,
        type: 'select',
        options: ['gold', 'gold'],
      }).success,
    ).toBe(false);
  });
});

describe('customFieldUpdateRequestSchema', () => {
  it('cannot name a key, so an immutable field is not something to refuse', () => {
    const parsed = customFieldUpdateRequestSchema.parse({ label: 'Tier', key: 'other' });

    expect(parsed).not.toHaveProperty('key');
  });

  it('refuses a body that changes nothing', () => {
    expect(customFieldUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(customFieldUpdateRequestSchema.safeParse({ force: true }).success).toBe(false);
  });

  it('checks options against the type only when the request moves the type', () => {
    // A request that renames the label says nothing about options, and the
    // stored ones stand.
    expect(customFieldUpdateRequestSchema.safeParse({ label: 'Tier' }).success).toBe(true);
    expect(customFieldUpdateRequestSchema.safeParse({ type: 'select', options: [] }).success).toBe(
      false,
    );
  });
});

describe('missingRequiredToClose (M14-17)', () => {
  const gate = (over: Partial<RequiredToCloseRule> = {}): RequiredToCloseRule => ({
    key: 'plan',
    type: 'text',
    requiredToClose: true,
    ...over,
  });

  it('names the fields a close would leave empty, in definition order', () => {
    const rules = [gate({ key: 'loss_reason' }), gate({ key: 'plan' })];

    expect(missingRequiredToClose(rules, { plan: 'gold' })).toEqual(['loss_reason']);
    expect(missingRequiredToClose(rules, {})).toEqual(['loss_reason', 'plan']);
    expect(missingRequiredToClose(rules, { plan: 'gold', loss_reason: 'shipping' })).toEqual([]);
  });

  it('leaves a field the brand has not gated out of the answer', () => {
    expect(missingRequiredToClose([gate({ requiredToClose: false })], {})).toEqual([]);
  });

  it('reads a null as empty, because clearing is not filling in', () => {
    expect(missingRequiredToClose([gate()], { plan: null })).toEqual(['plan']);
  });

  it('reads a blank text as empty', () => {
    expect(missingRequiredToClose([gate()], { plan: '   ' })).toEqual(['plan']);
  });

  it('reads an empty multi-select as empty', () => {
    const rules = [gate({ key: 'carriers', type: 'multi_select' })];

    expect(missingRequiredToClose(rules, { carriers: [] })).toEqual(['carriers']);
    expect(missingRequiredToClose(rules, { carriers: ['dhl'] })).toEqual([]);
  });

  it('reads an unticked checkbox as empty: the gate is something a person acts on', () => {
    const rules = [gate({ key: 'refunded', type: 'checkbox' })];

    expect(missingRequiredToClose(rules, { refunded: false })).toEqual(['refunded']);
    expect(missingRequiredToClose(rules, { refunded: true })).toEqual([]);
  });

  it('reads a blank long text, link, email and person as empty, and a value as filled', () => {
    const rules = [
      gate({ key: 'notes', type: 'long_text' }),
      gate({ key: 'page', type: 'link' }),
      gate({ key: 'billing', type: 'email' }),
      gate({ key: 'owner', type: 'person' }),
    ];

    expect(missingRequiredToClose(rules, { notes: '  ', page: '', billing: null })).toEqual([
      'notes',
      'page',
      'billing',
      'owner',
    ]);
    expect(
      missingRequiredToClose(rules, {
        notes: 'x',
        page: 'https://a.co',
        billing: 'a@b.co',
        owner: 'id',
      }),
    ).toEqual([]);
  });

  it('reads a zero and a chosen option as filled', () => {
    const rules = [
      gate({ key: 'attempts', type: 'number' }),
      gate({ key: 'carrier', type: 'select' }),
      gate({ key: 'by', type: 'date' }),
    ];

    expect(
      missingRequiredToClose(rules, { attempts: 0, carrier: 'dhl', by: '2026-01-02' }),
    ).toEqual([]);
  });

  it('answers an empty list for values that are not there at all', () => {
    expect(missingRequiredToClose([gate()], null)).toEqual(['plan']);
    expect(missingRequiredToClose([], undefined)).toEqual([]);
  });
});
