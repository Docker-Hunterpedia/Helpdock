import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/** Help center › Insights (M5-08, `Admin/HelpCenter-Settings` board 2) against the fixture. */

const renderInsights = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    helpCenterApi: apis.helpCenter,
    initialEntries: ['/help-center/insights'],
  });
  await screen.findByRole('table', { name: 'Top searches' }, { timeout: 5000 });
  return { ...rendered, apis };
};

const rowsOf = (name: string) =>
  within(screen.getByRole('table', { name })).getAllByRole('row').slice(1);

describe('the Insights tab', () => {
  it('shows top searches, searches with no results and the articles table', async () => {
    await renderInsights();

    expect(rowsOf('Top searches')[0]).toHaveTextContent(/refund\s*412\s*68 %/);
    expect(rowsOf('Searches with no results')[0]).toHaveTextContent(/klarna\s*23/);
    const [first] = rowsOf('Articles');
    expect(first).toHaveTextContent('Refund timelines');
    expect(first).toHaveTextContent('2,184');
    expect(first).toHaveTextContent('86 %');
    expect(first).toHaveTextContent('212 of 246');
    expect(first).toHaveTextContent('9 comments');
    expect(
      within(first as HTMLElement).getByRole('link', { name: 'Refund timelines' }),
    ).toHaveAttribute('href', expect.stringContaining('/help-center/articles/'));
    expect(screen.getByText('No answers yet')).toBeInTheDocument();
  });

  it('marks an Arabic search as Arabic, whatever the page language', async () => {
    await renderInsights();

    const arabic = screen.getByText('استرداد');
    expect(arabic).toHaveAttribute('lang', 'ar');
    expect(arabic).toHaveAttribute('dir', 'rtl');
  });

  it('asks again for one language, and sorts by the least helpful', async () => {
    const { user, apis } = await renderInsights();
    const insights = vi.spyOn(apis.helpCenter, 'insights');

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Arabic' }));
    await waitFor(() => {
      expect(rowsOf('Top searches')).toHaveLength(1);
    });
    expect(insights).toHaveBeenLastCalledWith(expect.any(String), {
      days: 30,
      sort: 'views',
      locale: 'ar',
    });

    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(await screen.findByRole('option', { name: 'Least helpful' }));
    await waitFor(() => {
      expect(insights).toHaveBeenLastCalledWith(expect.any(String), {
        days: 30,
        sort: 'least_helpful',
        locale: 'ar',
      });
    });

    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(await screen.findByRole('option', { name: 'Last 7 days' }));
    await waitFor(() => {
      expect(insights).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ days: 7 }),
      );
    });
  });

  it('opens a draft titled with a search nothing answered', async () => {
    const { user, apis } = await renderInsights();
    const create = vi.spyOn(apis.helpCenter, 'createArticle');

    await user.click(screen.getByRole('button', { name: 'Write an article for “klarna”' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ title: 'klarna', locale: 'en' }),
      );
    });
    expect(await screen.findByRole('textbox', { name: /Title/ }, { timeout: 5000 })).toHaveValue(
      'klarna',
    );
  });

  it('says so when the numbers cannot be read, and tries again', async () => {
    const apis = await signedInMockApis();
    const insights = vi
      .spyOn(apis.helpCenter, 'insights')
      .mockRejectedValueOnce(new Error('offline'));
    const { user } = renderApp(<AppRoutes />, {
      authApi: apis.auth,
      staffApi: apis.staff,
      helpCenterApi: apis.helpCenter,
      initialEntries: ['/help-center/insights'],
    });

    expect(
      await screen.findByText('Insights could not be loaded.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Top searches' })).toBeInTheDocument();
    expect(insights).toHaveBeenCalledTimes(2);
  });
});
