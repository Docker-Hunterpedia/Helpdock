import { createI18n } from '@helpdock/i18n';
import type { ImportFileTransform } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.js';
import { ImportFileTransforms } from './import-file-transforms.js';

it.each(['en', 'ar'] as const)(
  'keeps value edits focused and attached to the right transform after removing rows in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    function Editor() {
      const [value, setValue] = useState<ImportFileTransform[]>([
        { kind: 'join', separator: ' ' },
        {
          kind: 'values',
          entries: [
            { from: 'Open', to: 'open' },
            { from: 'Closed', to: 'closed' },
          ],
        },
      ]);
      return <ImportFileTransforms value={value} onChange={setValue} disabled={false} />;
    }
    const { user } = renderApp(<Editor />);
    const first = screen.getAllByRole('textbox', { name: t('columns.fromValue') })[0];
    if (!first) throw new Error('Missing source mapping');
    await user.clear(first);
    await user.type(first, 'Pending');
    expect(first).toHaveValue('Pending');
    expect(first).toHaveFocus();
    const removeValue = screen.getAllByRole('button', { name: t('columns.removeValue') })[0];
    if (!removeValue) throw new Error('Missing removal action');
    await user.click(removeValue);
    const remaining = screen.getByRole('textbox', { name: t('columns.fromValue') });
    expect(remaining).toHaveValue('Closed');
    await user.clear(remaining);
    await user.type(remaining, 'Resolved');
    expect(remaining).toHaveValue('Resolved');
    expect(remaining).toHaveFocus();
    const removeTransform = screen.getAllByRole('button', {
      name: t('columns.removeTransform'),
    })[0];
    if (!removeTransform) throw new Error('Missing transform removal');
    await user.click(removeTransform);
    expect(screen.queryByRole('textbox', { name: t('columns.separator') })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: t('columns.fromValue') })).toHaveValue('Resolved');
  },
);
