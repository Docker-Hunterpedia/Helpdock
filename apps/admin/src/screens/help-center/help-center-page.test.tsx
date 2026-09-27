import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_HELP_CENTER } from '../../help-center/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { helpCenterTabsFor, managesHelpCenter } from './help-center-page.tsx';

/**
 * `Admin/HelpCenter` against the fixture: the tree, the list, its filters and
 * "Who can read it".
 */

const renderHelpCenter = async (path = '/help-center') => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    helpCenterApi: apis.helpCenter,
    initialEntries: [path],
  });
  if (path === '/help-center') {
    // Signing in and the first read take a while on a busy machine.
    await screen.findByRole('button', { name: /Refund timelines/ }, { timeout: 5000 });
  }
  return { ...rendered, apis };
};

const openRefunds = async (user: Awaited<ReturnType<typeof renderHelpCenter>>['user']) => {
  await user.click(await screen.findByRole('button', { name: 'Expand Returns & refunds' }));
  await user.click(screen.getByRole('button', { name: 'Refunds' }));
};

describe('who sees what', () => {
  it('gives an Agent the Articles tab alone and nothing to change', () => {
    expect(helpCenterTabsFor('agent').map((tab) => tab.key)).toEqual(['articles']);
    expect(helpCenterTabsFor('viewer').map((tab) => tab.key)).toEqual([
      'articles',
      'settings',
      'insights',
    ]);
    expect(managesHelpCenter('teamLeader')).toBe(true);
    expect(managesHelpCenter('viewer')).toBe(false);
  });
});

describe('the Articles tab', () => {
  it('lists the section the tree selects, with status, visibility and languages', async () => {
    const { user } = await renderHelpCenter();
    await openRefunds(user);

    const table = await screen.findByRole('table', { name: 'Articles in Refunds' });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(within(table).getByText('Scheduled · 1 Oct 09:00')).toBeInTheDocument();
    expect(within(table).getAllByText('Arabic missing')).toHaveLength(2);
    expect(within(table).getByText('Internal')).toBeInTheDocument();
    expect(screen.getByText('6 of 7 articles')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear the section filter' }));
    expect(await screen.findByRole('table', { name: 'All articles' })).toBeInTheDocument();
  });

  it('narrows by title', async () => {
    const { user } = await renderHelpCenter();
    await user.type(await screen.findByRole('searchbox', { name: 'Search titles' }), 'bundles');

    const table = screen.getByRole('table', { name: 'All articles' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('1 of 7 articles')).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search titles' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search titles' }), 'nothing like it');
    expect(screen.getByText('No article matches these filters.')).toBeInTheDocument();
  });

  it('reorders with the keyboard and says so', async () => {
    const { user, apis } = await renderHelpCenter();
    await openRefunds(user);
    await user.click(screen.getByRole('button', { name: 'Expand Refunds' }));

    screen.getByRole('button', { name: 'Move Refund timelines' }).focus();
    await user.keyboard('{ArrowDown}');

    await screen.findByText('Order saved');
    const structure = await apis.helpCenter.structure('brand');
    const refunds = structure.articles
      .filter((row) => row.sectionId === MOCK_HELP_CENTER.sections.refunds)
      .sort((a, b) => a.position - b.position);
    expect(refunds[1]?.id).toBe(MOCK_HELP_CENTER.articles.timelines);
  });

  it('creates a category and a section, and shows the empty state inside it', async () => {
    const { user } = await renderHelpCenter();
    await user.click(await screen.findByRole('button', { name: 'Category' }));
    const dialog = screen.getByRole('dialog', { name: 'New category' });
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('English name'), 'Payments');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await screen.findByText('Category "Payments" created');

    await user.click(await screen.findByRole('button', { name: 'Expand Payments' }));
    const addSection = screen.getAllByRole('button', { name: 'Section' });
    await user.click(addSection[addSection.length - 1] as HTMLElement);
    const sectionDialog = screen.getByRole('dialog', { name: 'New section' });
    await user.type(within(sectionDialog).getByLabelText('Arabic name'), 'الفواتير');
    await user.click(within(sectionDialog).getByRole('button', { name: 'Create' }));
    await screen.findByText('Section "الفواتير" created');

    await user.click(await screen.findByRole('button', { name: 'الفواتير' }));
    expect(await screen.findByText('No articles here yet')).toBeInTheDocument();
  });

  it('refuses to delete a published article and says why', async () => {
    const { user } = await renderHelpCenter();
    await user.click(await screen.findByRole('button', { name: 'Actions for Refund timelines' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete article' }));

    expect(
      await screen.findByText('This article has been published. Archive it instead.'),
    ).toBeInTheDocument();
  });

  it('deletes a draft', async () => {
    const { user } = await renderHelpCenter();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for How we calculate restocking fees' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete article' }));

    expect(
      await screen.findByText('"How we calculate restocking fees" deleted'),
    ).toBeInTheDocument();
  });

  it('opens a new draft in the editor', async () => {
    const { user } = await renderHelpCenter();
    await openRefunds(user);
    await user.click(screen.getByRole('button', { name: 'New article' }));

    expect(
      await screen.findByDisplayValue('Untitled article 7', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});

describe('Who can read it', () => {
  it('switches the help center to internal only', async () => {
    const { user, apis } = await renderHelpCenter('/help-center/settings');
    const internal = await screen.findByRole('radio', { name: /Internal only/ }, { timeout: 5000 });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.click(internal);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('radio', { name: /Public/ })).toBeChecked();

    await user.click(internal);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Saved. It takes effect within 60 s.');
    await waitFor(async () => {
      expect(await apis.helpCenter.settings('brand')).toEqual({ access: 'internal_only' });
    });
  });

  it('says where Insights will come from', async () => {
    await renderHelpCenter('/help-center/insights');
    expect(
      await screen.findByRole('heading', { name: 'Insights' }, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('opens Articles for a tab that does not exist', async () => {
    await renderHelpCenter('/help-center/nope');
    expect(
      await screen.findByRole('heading', { name: 'Structure' }, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});
