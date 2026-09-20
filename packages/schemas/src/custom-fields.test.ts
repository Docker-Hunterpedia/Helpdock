import { describe, expect, it } from 'vitest';
import {
  type CustomFieldDef,
  type CustomFieldRule,
  customFieldCreateRequestSchema,
  customFieldKeySchema,
  customFieldUpdateRequestSchema,
  customValuesSchema,
  mergeCustomValues,
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
    agentVisible: true,
    sortOrder: 0,
  });

  it('drops a key whose definition has been deleted', () => {
    // Deleting a definition does not rewrite every row that used it, so reads
    // filter rather than trusting what is stored.
    expect(visibleCustomValues({ plan: 'gold', gone: 'x' }, [def('plan')])).toEqual({
      plan: 'gold',
    });
  });
});

describe('customFieldCreateRequestSchema', () => {
  const valid = { target: 'ticket', key: 'tier', label: 'Tier', type: 'text' };

  it('defaults the flags a brand rarely sets', () => {
    expect(customFieldCreateRequestSchema.parse(valid)).toMatchObject({
      options: [],
      required: false,
      agentVisible: true,
    });
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
