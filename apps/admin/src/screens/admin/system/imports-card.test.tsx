import type { ImportHealth, ImportHealthPage } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import { fakeSystemApi } from './fixtures.js';
import { ImportsCard } from './imports-card.js';

const snapshotId = '019a0000-0000-7000-8000-000000000001';
const brands = Array.from({ length: 57 }, (_, index) => ({
  brandId: `019a0000-0000-7000-8000-${String(index + 10).padStart(12, '0')}`,
  brandName: `Brand ${index + 1}`,
  active: 1,
  paused: 0,
  lastError: null,
}));
const health: Extract<ImportHealth, { configured: true }> = {
  configured: true,
  snapshotId,
  observedAt: '2026-10-17T12:00:00.000Z',
  totalBrands: 57,
  active: 57,
  paused: 0,
  brands: brands.slice(0, 50),
};

it.each(['en', 'ar'] as const)(
  'pages the same reading and returns to the latest summary in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const imports = vi.fn(
      async ({ page }: { snapshotId?: string; page: number }): Promise<ImportHealthPage> => ({
        ...health,
        brands: brands.slice((page - 1) * 50, page * 50),
        page,
        hasNext: page === 1,
      }),
    );
    const { user } = renderApp(<ImportsCard health={health} api={fakeSystemApi({ imports })} />);
    const next = locale === 'en' ? 'Next brands' : 'العلامات التالية';
    const previous = locale === 'en' ? 'Previous brands' : 'العلامات السابقة';
    const latest = locale === 'en' ? 'Return to latest snapshot' : 'العودة إلى أحدث لقطة';
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(51);
    expect(screen.getByRole('button', { name: previous })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: next }));
    expect(await screen.findByText('Brand 57')).toBeVisible();
    expect(screen.queryByText('Brand 1')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(8);
    expect(imports).toHaveBeenCalledWith({ snapshotId, page: 2 });
    expect(screen.getByRole('button', { name: next })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: previous }));
    expect(await screen.findByText('Brand 1')).toBeVisible();
    expect(imports).toHaveBeenLastCalledWith({ snapshotId, page: 1 });
    await user.click(screen.getByRole('button', { name: latest }));
    expect(screen.queryByRole('button', { name: latest })).not.toBeInTheDocument();
    expect(screen.getByText('Brand 1')).toBeVisible();
  },
);

it('keeps expiration distinct from zero and permits returning to the current summary', async () => {
  const { user } = renderApp(<ImportsCard health={health} api={fakeSystemApi()} />);
  await user.click(screen.getByRole('button', { name: 'Next brands' }));
  expect(
    await screen.findByText('The worker has not reported an import snapshot recently.'),
  ).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Return to latest snapshot' }));
  expect(screen.getByText('Brand 1')).toBeVisible();
});

it('offers retry after a failed page request without replacing it with a zero reading', async () => {
  const imports = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      ...health,
      brands: brands.slice(50),
      page: 2,
      hasNext: false,
    });
  const { user } = renderApp(<ImportsCard health={health} api={fakeSystemApi({ imports })} />);
  await user.click(screen.getByRole('button', { name: 'Next brands' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not read this import snapshot.',
  );
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Brand 57')).toBeVisible();
});
