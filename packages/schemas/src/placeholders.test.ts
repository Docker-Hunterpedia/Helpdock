import { describe, expect, it } from 'vitest';
import {
  AGENT_PLACEHOLDERS,
  agentPlaceholderValues,
  jobTitleFor,
  publicNameOf,
  renderSegments,
  renderSignature,
  renderTemplate,
} from './placeholders.js';

const values = new Map([
  ['contact.first_name', 'Mona'],
  ['ticket.number', 'HD-1042'],
]);

describe('renderSegments', () => {
  it('keeps the runs that came from a placeholder apart, so a screen can mark them', () => {
    expect(renderSegments('Hi {{contact.first_name}}, about {{ticket.number}}.', values)).toEqual({
      segments: [
        { text: 'Hi ', placeholder: null },
        { text: 'Mona', placeholder: 'contact.first_name' },
        { text: ', about ', placeholder: null },
        { text: 'HD-1042', placeholder: 'ticket.number' },
        { text: '.', placeholder: null },
      ],
      unknown: [],
    });
  });

  it('leaves an unknown placeholder as written, unmarked, and reports it', () => {
    expect(renderSegments('{{contcat.name}}', values)).toEqual({
      segments: [{ text: '{{contcat.name}}', placeholder: null }],
      unknown: ['contcat.name'],
    });
  });

  it('answers text with no placeholders as one run', () => {
    expect(renderSegments('Thanks!', values).segments).toEqual([
      { text: 'Thanks!', placeholder: null },
    ]);
  });
});

describe('fallbacks (M14-14)', () => {
  const sparse = new Map([
    ['contact.first_name', ''],
    ['ticket.number', 'HD-1042'],
  ]);

  it('renders the words after | when the value is empty', () => {
    expect(renderTemplate('Hi {{contact.first_name|there}},', sparse).text).toBe('Hi there,');
    expect(renderTemplate('Hi {{ contact.first_name | there friend }},', sparse).text).toBe(
      'Hi there friend,',
    );
  });

  it('renders the value, not the fallback, when there is one', () => {
    expect(renderTemplate('Hi {{contact.first_name|there}},', values).text).toBe('Hi Mona,');
  });

  it('uses the fallback for a name the subject cannot fill, without calling it unknown', () => {
    expect(renderSegments('{{contact.email|your email}}', values)).toEqual({
      segments: [{ text: 'your email', placeholder: 'contact.email' }],
      unknown: [],
    });
  });

  it('still renders an empty value as nothing when no fallback is given', () => {
    expect(renderTemplate('Hi {{contact.first_name}}!', sparse).text).toBe('Hi !');
    expect(renderTemplate('Hi {{contact.first_name|}}!', sparse).text).toBe('Hi !');
  });

  it('inserts a fallback literally, never expanding it', () => {
    expect(renderTemplate('{{contact.first_name|$& x}}', sparse).text).toBe('$& x');
  });
});

describe('renderTemplate', () => {
  it('is the segments joined', () => {
    expect(renderTemplate('Re: {{ticket.number}}', values)).toEqual({
      text: 'Re: HD-1042',
      unknown: [],
    });
  });
});

describe('the sender as a customer meets them (M14-12)', () => {
  const lina = {
    fullName: 'Lina Haddad',
    publicName: 'Lina H',
    jobTitleEn: 'Billing specialist',
    jobTitleAr: 'أخصائية الفوترة',
    phone: '+966551234567',
  };

  describe('publicNameOf', () => {
    it('is the public name when one is set', () => {
      expect(publicNameOf(lina)).toBe('Lina H');
    });

    it.each([null, undefined, '', '   '])(
      'is the first name when the public name is %j',
      (blank) => {
        expect(publicNameOf({ fullName: 'Lina Haddad', publicName: blank })).toBe('Lina');
      },
    );

    it('trims the public name and never falls back to the surname', () => {
      expect(publicNameOf({ fullName: 'Lina Haddad', publicName: '  Support Team ' })).toBe(
        'Support Team',
      );
      expect(publicNameOf({ fullName: 'Lina Haddad' })).not.toContain('Haddad');
    });
  });

  describe('jobTitleFor', () => {
    it('answers in the language of the reply', () => {
      expect(jobTitleFor(lina, 'en')).toBe('Billing specialist');
      expect(jobTitleFor(lina, 'ar')).toBe('أخصائية الفوترة');
    });

    it('falls back from an empty Arabic title to the English one, and never the other way', () => {
      expect(jobTitleFor({ ...lina, jobTitleAr: ' ' }, 'ar')).toBe('Billing specialist');
      expect(jobTitleFor({ ...lina, jobTitleEn: null }, 'en')).toBeNull();
    });

    it('is null when neither language has a title', () => {
      expect(jobTitleFor({ fullName: 'Lina' }, 'ar')).toBeNull();
    });
  });

  describe('agentPlaceholderValues', () => {
    it('fills every placeholder of the allow-list, and nothing else', () => {
      const filled = agentPlaceholderValues(lina, 'en', 'Billing');

      expect([...filled.keys()].sort()).toEqual([...AGENT_PLACEHOLDERS].sort());
      expect(filled.get('agent.name')).toBe('Lina H');
      expect(filled.get('agent.full_name')).toBe('Lina Haddad');
      expect(filled.get('agent.title')).toBe('Billing specialist');
      expect(filled.get('agent.phone')).toBe('+966551234567');
      expect(filled.get('department.name')).toBe('Billing');
    });

    it('fills what the person left unset with nothing, so no customer reads a placeholder', () => {
      const filled = agentPlaceholderValues({ fullName: 'Lina Haddad' }, 'en', null);

      expect(filled.get('agent.title')).toBe('');
      expect(filled.get('agent.phone')).toBe('');
      expect(filled.get('department.name')).toBe('');
      expect(filled.get('agent.name')).toBe('Lina');
    });
  });

  describe('renderSignature', () => {
    const filled = new Map<string, string>([
      ...agentPlaceholderValues(lina, 'en', 'Billing'),
      ['brand.name', 'Helpdock'],
    ]);

    it('fills each line', () => {
      expect(
        renderSignature(
          '{{agent.name}}\n{{agent.title}} · {{brand.name}}\n{{agent.phone}}',
          filled,
        ),
      ).toBe('Lina H\nBilling specialist · Helpdock\n+966551234567');
    });

    it('drops the line of a placeholder that came out empty', () => {
      const bare = new Map([...filled, ['agent.phone', '']]);

      expect(renderSignature('{{agent.name}}\n{{agent.phone}}', bare)).toBe('Lina H');
    });

    it('takes the separator off a line whose placeholder came out empty', () => {
      const untitled = new Map([...filled, ['agent.title', '']]);

      expect(renderSignature('{{agent.title}} · {{brand.name}}', untitled)).toBe('Helpdock');
      expect(renderSignature('{{brand.name}} / {{agent.title}}', untitled)).toBe('Helpdock');
    });

    it('keeps lines without placeholders as typed, blank ones included', () => {
      expect(renderSignature('Thanks,\n\n{{agent.name}} - Team', filled)).toBe(
        'Thanks,\n\nLina H - Team',
      );
    });

    it('leaves an unknown placeholder spelled out rather than hiding a typo', () => {
      expect(renderSignature('{{agent.nmae}}', filled)).toBe('{{agent.nmae}}');
    });

    it('does not expand a value that contains a placeholder', () => {
      const tricky = new Map([...filled, ['agent.name', '{{agent.phone}}']]);

      expect(renderSignature('{{agent.name}}', tricky)).toBe('{{agent.phone}}');
    });
  });
});
