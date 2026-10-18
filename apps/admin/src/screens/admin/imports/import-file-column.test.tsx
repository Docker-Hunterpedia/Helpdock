import { createI18n } from '@helpdock/i18n';
import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import type { FileColumnRule } from '../../../imports/file-columns.js';
import { renderApp } from '../../../test/render.js';
import { ImportFileColumn } from './import-file-column.js';

it.each(['en', 'ar'] as const)(
  'keeps an unknown saved destination visible and offers localized message fields in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const rule: FileColumnRule = {
      id: 'source-column',
      target: 'future_source_fact',
      source: { kind: 'columns', names: ['Subject'] },
      transforms: [],
      omitEmpty: true,
    };
    const changed = vi.fn();
    const { user } = renderApp(
      <ImportFileColumn
        entity="ticket"
        headers={['Subject']}
        rule={rule}
        firstCells={['Original question']}
        disabled={false}
        onChange={changed}
        onDuplicate={() => {}}
      />,
    );
    const destination = screen.getByRole('combobox', { name: t('columns.destination') });
    expect(destination).toHaveTextContent('future_source_fact');
    await user.click(destination);
    await user.click(
      screen.getByRole('option', {
        name: `${t('columns.firstMessage')} · ${t('columns.fields.bodyText')}`,
      }),
    );
    expect(changed).toHaveBeenCalledWith({ ...rule, target: 'firstMessage.bodyText' });
  },
);
