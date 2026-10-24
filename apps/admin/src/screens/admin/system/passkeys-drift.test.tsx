import type { InstallPasskeys } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_INSTALL_PASSKEYS, MockSettingsApi } from '../../../settings/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { PasskeysDrift } from './passkeys-drift.tsx';

const renderWith = (status: Partial<InstallPasskeys> | Error) => {
  const api = new MockSettingsApi();
  vi.spyOn(api, 'passkeys').mockImplementation(() =>
    status instanceof Error
      ? Promise.reject(status)
      : Promise.resolve({ ...MOCK_INSTALL_PASSKEYS, ...status }),
  );
  return renderApp(<PasskeysDrift />, { settingsApi: api });
};

describe('PasskeysDrift', () => {
  it('warns on the System page, naming both hosts and linking to Settings', async () => {
    renderWith({ state: 'paused', rpId: 'desk.helpdock.com', pinnedRpId: 'admin.helpdock.com' });

    expect(await screen.findByText("This install's address changed")).toBeVisible();
    expect(screen.getByText('admin.helpdock.com')).toBeVisible();
    expect(screen.getByText('desk.helpdock.com')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Settings › Authentication' })).toHaveAttribute(
      'href',
      '/admin/settings',
    );
  });

  it.each([
    ['passkeys work', { state: 'available' as const }],
    ['passkeys are off', { state: 'unavailable' as const, rpId: null, pinnedRpId: null }],
  ])('draws nothing when %s', async (_label, status) => {
    const { container } = renderWith(status);

    await vi.waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeNull();
    });
    expect(screen.queryByText("This install's address changed")).not.toBeInTheDocument();
  });

  it('draws nothing when the status cannot be read', async () => {
    renderWith(new Error('down'));

    await vi.waitFor(() => {
      expect(screen.queryByText("This install's address changed")).not.toBeInTheDocument();
    });
  });
});
