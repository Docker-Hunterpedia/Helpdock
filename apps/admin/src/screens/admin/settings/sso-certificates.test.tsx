import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { SsoCertificates } from './sso-certificates.tsx';

function Editor() {
  const [certificates, setCertificates] = useState<string[]>([]);
  return <SsoCertificates certificates={certificates} onChange={setCertificates} />;
}

it('keeps refused certificate input editable and supports adding and removing a public certificate', async () => {
  const { user } = renderApp(<Editor />);
  await user.click(screen.getByRole('button', { name: 'Add certificate' }));
  const dialog = within(screen.getByRole('dialog'));
  const pem = dialog.getByLabelText('Certificate (PEM)');
  await user.type(pem, 'malformed');
  await user.click(dialog.getByRole('button', { name: 'Add certificate' }));
  expect(
    await dialog.findByText(
      'The signing certificate is invalid. Use an RSA certificate with at least 2048 bits.',
    ),
  ).toBeVisible();
  expect(pem).toHaveValue('malformed');
  // The mock API supplies the inspection response; real PEM/RSA checks belong to API integration tests.
  await user.clear(pem);
  await user.type(pem, '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----');
  await user.click(dialog.getByRole('button', { name: 'Add certificate' }));
  expect(await screen.findByText('Mock identity provider')).toBeVisible();
  await user.click(await screen.findByRole('button', { name: 'Remove certificate' }));
  expect(screen.queryByText('Mock identity provider')).not.toBeInTheDocument();
});
