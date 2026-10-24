import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_ENROLMENT_CODE, MOCK_STALE_ROTATION_CODE } from '../../staff/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * Replacing the authenticator on `/me/security` (#373), against the fixture:
 * the proof step, the staged secret, and the confirmation that swaps the app.
 * The browser tests walk the same flow in both languages.
 */

const renderWith = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    initialEntries: ['/me/security'],
  });
  await screen.findByRole('heading', { name: 'Your account', level: 1 });

  return { ...rendered, staff: apis.staff };
};

const openDialog = async (): Promise<HTMLElement> => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Replace app' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText("Confirm it's you");

  return dialog;
};

describe('replacing the authenticator app (#373)', () => {
  it('walks proof, scan and confirm, and says the old app stopped working', async () => {
    const user = userEvent.setup();
    const { staff } = await renderWith();
    const dialog = await openDialog();

    await user.type(
      within(dialog).getByLabelText('Code from your current app, or a recovery code'),
      MOCK_ENROLMENT_CODE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await within(dialog).findByText('Replace authenticator app');
    expect(within(dialog).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();

    await user.type(
      within(dialog).getByLabelText('6-digit code from the new app'),
      MOCK_ENROLMENT_CODE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Replace app' }));

    expect(
      await screen.findByText(
        'Your authenticator app was replaced. Codes from the old app no longer work. We emailed you about it.',
      ),
    ).toBeInTheDocument();
    await expect(staff.profile()).resolves.toMatchObject({ twoFactorEnabled: true });
  });

  it('says a wrong proof in the field and stages nothing', async () => {
    const user = userEvent.setup();
    await renderWith();
    const dialog = await openDialog();

    await user.type(
      within(dialog).getByLabelText('Code from your current app, or a recovery code'),
      '000000',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(
      await within(dialog).findByText('That password or code did not match.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Replace authenticator app')).not.toBeInTheDocument();
  });

  it('takes the password with a recovery code when the phone is gone', async () => {
    const user = userEvent.setup();
    await renderWith();
    const dialog = await openDialog();

    await user.click(
      within(dialog).getByRole('button', {
        name: 'Use your password and a recovery code instead',
      }),
    );
    await user.type(within(dialog).getByLabelText('Current password'), 'correct horse');
    await user.type(within(dialog).getByLabelText('Recovery code'), 'RC-4KQ2-9XMT');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await within(dialog).findByText('Replace authenticator app')).toBeInTheDocument();
  });

  it('refuses a wrong code from the new app and keeps the staged secret', async () => {
    const user = userEvent.setup();
    await renderWith();
    const dialog = await openDialog();

    await user.type(
      within(dialog).getByLabelText('Code from your current app, or a recovery code'),
      MOCK_ENROLMENT_CODE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await within(dialog).findByText('Replace authenticator app');

    await user.type(within(dialog).getByLabelText('6-digit code from the new app'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Replace app' }));

    expect(await within(dialog).findByText('That code did not match.')).toBeInTheDocument();
    expect(within(dialog).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
  });

  it('shows the key in groups of four, left to right', async () => {
    const user = userEvent.setup();
    await renderWith();
    const dialog = await openDialog();
    await user.type(
      within(dialog).getByLabelText('Code from your current app, or a recovery code'),
      MOCK_ENROLMENT_CODE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await within(dialog).findByText('Or enter this key');

    expect(within(dialog).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toHaveAttribute(
      'dir',
      'ltr',
    );
  });

  it('says start again when the replacement went stale, and changes nothing', async () => {
    const user = userEvent.setup();
    await renderWith();
    const dialog = await openDialog();
    await user.type(
      within(dialog).getByLabelText('Code from your current app, or a recovery code'),
      MOCK_ENROLMENT_CODE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await within(dialog).findByText('Or enter this key');

    await user.type(
      within(dialog).getByLabelText('6-digit code from the new app'),
      MOCK_STALE_ROTATION_CODE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Replace app' }));

    expect(
      await screen.findByText(
        'This replacement expired or your factors changed since it started. Start again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
