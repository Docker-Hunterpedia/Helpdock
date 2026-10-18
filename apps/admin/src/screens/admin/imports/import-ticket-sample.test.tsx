import { createI18n } from '@helpdock/i18n';
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { mockTicketPreview } from '../../../imports/mock-data.js';
import { renderApp } from '../../../test/render.js';
import { ImportTicketSample } from './import-ticket-sample.js';

it.each(['en', 'ar'] as const)(
  'distinguishes unchecked, missing, refused and available files in the %s dry run',
  (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const preview = mockTicketPreview();
    const message = preview.messages[0];
    if (!message) throw new Error('Missing preview message');
    message.attachments.push(
      {
        externalId: 'refused',
        fileName: '<script>unsafe.pdf</script>',
        availability: { state: 'rejected', code: 'media-mime_mismatch' },
      },
      { externalId: 'unchecked', fileName: 'not-reviewed.pdf' },
    );
    const rendered = renderApp(
      <ImportTicketSample
        preview={preview}
        source="Zoho Desk"
        brandId="0193b000-0000-7000-8000-000000000901"
        runId="0193b000-0000-7000-8000-000000000902"
        revision="review-1"
      />,
    );
    for (const state of ['available', 'unavailable', 'rejected', 'not_checked'] as const)
      expect(screen.getByText(t(`dryRun.fileStates.${state}`))).toBeVisible();
    expect(screen.getByText('<script>unsafe.pdf</script>')).toBeVisible();
    expect(rendered.container.querySelector('script')).toBeNull();
    expect(rendered.container.querySelector('a[href*="token="]')).toBeNull();
  },
);
