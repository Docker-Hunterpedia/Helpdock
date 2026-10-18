import { createI18n } from '@helpdock/i18n';
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.js';
import { ImportedMessageDetails } from './imported-message-details.js';

it.each(['en', 'ar'] as const)(
  'discloses original source state as inert text and preserves an unresolved author category in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'tickets');
    const { user } = renderApp(
      <ImportedMessageDetails
        details={{
          status: 'FAILED',
          channel: 'EMAIL',
          authorKind: 'unknown',
          authorType: 'SOURCE_CUSTOM_TYPE',
          mailSubject: '<script>original mail subject</script>',
          mailDate: 'Fri, 01 Nov 2013 15:00:00 +0530',
          mailReturnPath: '<bounce@example.test>',
        }}
      />,
    );
    expect(screen.getByText('FAILED')).not.toBeVisible();
    await user.click(screen.getByText(t('importedMessage.title')));
    expect(screen.getByText('FAILED')).toBeVisible();
    expect(screen.getByText('EMAIL')).toBeVisible();
    expect(screen.getByText('SOURCE_CUSTOM_TYPE')).toBeVisible();
    expect(screen.getByText(t('importedMessage.kinds.unknown'))).toBeVisible();
    expect(screen.getByText('<script>original mail subject</script>')).toBeVisible();
    expect(
      screen
        .getByText('<script>original mail subject</script>')
        .closest('details')
        ?.querySelector('script'),
    ).toBeNull();
    expect(screen.getByText('Fri, 01 Nov 2013 15:00:00 +0530')).toBeVisible();
    expect(screen.getByText('<bounce@example.test>')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  },
);
