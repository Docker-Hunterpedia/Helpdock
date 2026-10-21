import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/** Your account › Profile (artboard `Admin/Account-Profile`, M14-12). */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const renderProfile = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    initialEntries: ['/me/profile'],
  });
  await screen.findByRole('heading', { name: 'Profile for customers' });
  // The fields fill from the stored profile a frame after the heading.
  await waitFor(() => {
    expect(screen.getByLabelText('Job title (English)')).toHaveValue('Billing specialist');
  });
  return { ...rendered, staff: apis.staff };
};

describe('the Profile tab', () => {
  it('is the first tab of Your account and shows what is stored', async () => {
    await renderProfile();

    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveAttribute('href', '/me/profile');
    expect(screen.getByLabelText('Name')).toHaveValue('Lina Haddad');
    expect(screen.getByLabelText('Public name')).toHaveValue('');
    expect(screen.getByLabelText('Public name')).toHaveAttribute('placeholder', 'Lina');
    expect(screen.getByLabelText('Job title (Arabic)')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('Phone')).toHaveValue('+966551234567');
    expect(screen.getByLabelText('Time zone')).toHaveValue('Asia/Riyadh');
    expect(screen.getByText('Shown only where a signature uses {{agent.phone}}.')).toBeVisible();
  });

  it('saves every field together and says so', async () => {
    const { user, staff } = await renderProfile();

    await user.type(screen.getByLabelText('Public name'), 'Lina H');
    await user.clear(screen.getByLabelText('Job title (English)'));
    await user.type(screen.getByLabelText('Job title (English)'), 'Support lead');
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '00966 55 987 6543');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Profile saved.')).toBeVisible();
    await expect(staff.profile()).resolves.toMatchObject({
      publicName: 'Lina H',
      displayName: 'Lina H',
      jobTitleEn: 'Support lead',
      phone: '+966559876543',
    });
  });

  it('clears a field that was emptied, and the public name goes back to the first name', async () => {
    const { user, staff } = await renderProfile();
    await staff.updateProfile({ publicName: 'Lina H' });
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await user.clear(screen.getByLabelText('Job title (Arabic)'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Profile saved.');
    await expect(staff.profile()).resolves.toMatchObject({ jobTitleAr: null, publicName: null });
  });

  it('refuses a phone that is not international before anything is sent', async () => {
    const { user, staff } = await renderProfile();

    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '0551234567');
    await user.type(screen.getByLabelText('Public name'), 'Not saved');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Enter an international number, like +966 55 123 4567.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Phone')).toHaveAttribute('aria-invalid', 'true');
    await expect(staff.profile()).resolves.toMatchObject({ publicName: null });
  });

  it('puts the stored values back on Discard', async () => {
    const { user } = await renderProfile();

    await user.type(screen.getByLabelText('Public name'), 'Temporary');
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByLabelText('Public name')).toHaveValue('');
  });

  describe('the photo', () => {
    it('uploads at once, shows it, and can remove it again', async () => {
      const { user, staff } = await renderProfile();

      await user.upload(
        screen.getByTestId('profile-photo-input'),
        new File([PNG], 'me.png', { type: 'image/png' }),
      );

      expect(await screen.findByText('Photo updated.')).toBeVisible();
      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Your photo' })).toBeVisible();
      });
      await expect(staff.profile().then((p) => p.photo)).resolves.not.toBeNull();

      await user.click(screen.getByRole('button', { name: 'Remove' }));
      expect(await screen.findByText('Photo removed.')).toBeVisible();
      await expect(staff.profile().then((p) => p.photo)).resolves.toBeNull();
      expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    });

    it('says so for a file that is not a JPEG, PNG or WebP, and sends nothing', async () => {
      const { staff } = await renderProfile();

      // `fireEvent`, because `user.upload` honours the input's `accept` and would send nothing.
      fireEvent.change(screen.getByTestId('profile-photo-input'), {
        target: { files: [new File(['hi'], 'me.gif', { type: 'image/gif' })] },
      });

      expect(await screen.findByRole('alert')).toHaveTextContent('Use a JPG, PNG or WebP image.');
      await expect(staff.profile().then((p) => p.photo)).resolves.toBeNull();
    });

    it('refuses a file over 5 MB', async () => {
      const { user } = await renderProfile();
      const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });

      await user.upload(screen.getByTestId('profile-photo-input'), big);

      expect(await screen.findByRole('alert')).toHaveTextContent('That photo is larger than 5 MB.');
    });

    it('reports a file the api refuses, as the api said it', async () => {
      const { user } = await renderProfile();

      // A PNG by its label and its type but not by its bytes: the sniff is the api's.
      await user.upload(
        screen.getByTestId('profile-photo-input'),
        new File(['<script>'], 'me.png', { type: 'image/png' }),
      );

      expect(await screen.findByRole('alert')).toHaveTextContent('Use a JPG, PNG or WebP image.');
    });
  });

  describe('Working in Helpdock', () => {
    it('holds the single-key shortcuts switch, on by default, and turns it off', async () => {
      const { user } = await renderProfile();
      const section = screen.getByRole('region', { name: 'Working in Helpdock' });
      const toggle = within(section).getByRole('switch', { name: 'Single-key shortcuts' });
      expect(toggle).toBeChecked();

      await user.click(toggle);

      await waitFor(() => {
        expect(toggle).not.toBeChecked();
      });
    });
  });
});
