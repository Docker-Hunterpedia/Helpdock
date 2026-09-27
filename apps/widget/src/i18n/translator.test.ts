import ar from '@helpdock/i18n/locales/ar/widget.json';
import en from '@helpdock/i18n/locales/en/widget.json';
import { describe, expect, it } from 'vitest';
import { direction, pickLocale, translatorFor } from './catalogs.js';
import { createTranslator } from './translator.js';

describe('createTranslator', () => {
  const t = createTranslator(
    {
      greeting: 'Hello {{name}}',
      nested: { key: 'Deep' },
      item_one: 'one item',
      item_other: '{{count}} items',
    },
    'en',
  );

  it('reads nested keys and interpolates, leaving unknown placeholders visible', () => {
    expect(t('nested.key')).toBe('Deep');
    expect(t('greeting', { name: 'Omar' })).toBe('Hello Omar');
    expect(t('greeting')).toBe('Hello {{name}}');
  });

  it('picks the plural form from count, as i18next does', () => {
    expect(t('item', { count: 1 })).toBe('one item');
    expect(t('item', { count: 3 })).toBe('3 items');
  });

  it('shows the key itself when it is missing, so a gap is visible rather than blank', () => {
    expect(t('nope.missing')).toBe('nope.missing');
  });
});

describe('the widget catalogs', () => {
  it('use all six Arabic plural forms', () => {
    const t = translatorFor('ar');

    expect(t('connection.newMessages', { count: 1 })).toBe(ar.connection.newMessages_one);
    expect(t('connection.newMessages', { count: 2 })).toBe(ar.connection.newMessages_two);
    expect(t('connection.newMessages', { count: 3 })).toBe('3 رسائل جديدة');
    expect(t('connection.newMessages', { count: 11 })).toBe('11 رسالة جديدة');
  });

  it('word the English strings the boards show', () => {
    const t = translatorFor('en');

    expect(t('header.chatTitle', { brand: 'Helpdock' })).toBe('Helpdock support');
    expect(t('message.notSent')).toBe(en.message.notSent);
  });
});

describe('locale and direction', () => {
  it('takes the page language when it is shipped, else the brand default', () => {
    expect(pickLocale('ar-SA', 'en')).toBe('ar');
    expect(pickLocale('fr', 'ar')).toBe('ar');
    expect(pickLocale(null, 'en')).toBe('en');
  });

  it('is right to left for Arabic only', () => {
    expect(direction('ar')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
  });
});
