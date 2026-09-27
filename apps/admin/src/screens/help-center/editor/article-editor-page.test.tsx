import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { articleRoute } from '../../../app/route-paths.js';
import { AppRoutes } from '../../../app/routes.tsx';
import { MOCK_HELP_CENTER } from '../../../help-center/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * `Admin/HelpCenter-Editor` against the fixture: the page, the settings
 * panel, autosave and the switches that apply at once. What typing into
 * TipTap does is the browser suite's (`e2e/help-center.spec.ts`).
 */

const M = MOCK_HELP_CENTER;

const renderEditor = async (articleId: string = M.articles.timelines) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    helpCenterApi: apis.helpCenter,
    initialEntries: [articleRoute(articleId)],
  });
  await screen.findByRole('complementary', { name: 'Article settings' }, { timeout: 5000 });
  return { ...rendered, apis };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('the article editor', () => {
  it('opens the reader’s language with its title, body and panel', async () => {
    await renderEditor();

    expect(screen.getByLabelText('Title')).toHaveValue('Refund timelines');
    expect(screen.getByRole('textbox', { name: 'Article body' })).toHaveTextContent(
      'How long each method takes',
    );
    expect(screen.getByText('Published 12 Sep by Lina Haddad.')).toBeInTheDocument();
    expect(screen.getByText('/en/articles/refund-timelines')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
  });

  it('switches to Arabic, edited right to left, and shows its schedule', async () => {
    const { user } = await renderEditor();
    const group = screen.getByRole('group', { name: 'Article language' });

    await user.click(within(group).getByRole('button', { name: /العربية/ }));

    await waitFor(() => {
      expect(screen.getByLabelText('Title')).toHaveValue('مواعيد استرداد المبالغ');
    });
    expect(screen.getByText('Editing Arabic, right to left.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title').closest('[dir]')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('Time')).toHaveValue('09:00');
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument();
  });

  it('autosaves the title a moment after typing stops, and then offers to publish', async () => {
    const { user } = await renderEditor();

    await user.type(screen.getByLabelText('Title'), ' by card');

    expect(await screen.findByText(/^Saved \d\d:\d\d$/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Publish changes' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    });
  });

  it('makes the version internal at once', async () => {
    const { user, apis } = await renderEditor();

    await user.click(screen.getByRole('radio', { name: 'Internal: signed-in staff only' }));

    await screen.findByText('Now internal. Search and sitemap update within 60 s.');
    const article = await apis.helpCenter.article('brand', M.articles.timelines);
    expect(article.versions.find((row) => row.locale === 'en')?.visibility).toBe('internal');
  });

  it('refuses a slug that is not one, and saves one that is', async () => {
    const { user } = await renderEditor();
    const slug = screen.getByLabelText('Slug');

    await user.clear(slug);
    await user.type(slug, 'Not A Slug!');
    fireEvent.blur(slug);
    expect(
      screen.getByText('Use lower-case letters, digits and single hyphens.'),
    ).toBeInTheDocument();

    await user.clear(slug);
    await user.type(slug, 'refund-times');
    fireEvent.blur(slug);
    await screen.findByText('Address saved');
  });

  it('refuses a slug another article has', async () => {
    const { user } = await renderEditor();
    const slug = screen.getByLabelText('Slug');

    await user.clear(slug);
    await user.type(slug, 'where-is-my-order');
    fireEvent.blur(slug);

    expect(
      await screen.findByText('Another article already uses that address.'),
    ).toBeInTheDocument();
  });

  it('archives from the Status select, and refuses a schedule in the past', async () => {
    const { user } = await renderEditor(M.articles.restocking);

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Scheduled' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2020-01-01' } });
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a time in the future.');

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Archived' }));
    await screen.findByText('Archived. Visitors see that it is gone.');
  });

  it('schedules for a time in the brand’s zone', async () => {
    const { user, apis } = await renderEditor(M.articles.restocking);

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Scheduled' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } });
    await user.click(screen.getByRole('button', { name: 'Schedule' }));

    await waitFor(async () => {
      const article = await apis.helpCenter.article('brand', M.articles.restocking);
      expect(article.versions[0]?.scheduledAt).toBe('2099-01-01T06:30:00.000Z');
    });
  });

  it('starts a language that is not written yet from its title', async () => {
    const { user, apis } = await renderEditor(M.articles.closedCard);
    const group = screen.getByRole('group', { name: 'Article language' });
    await user.click(within(group).getByRole('button', { name: /العربية/ }));

    expect(await screen.findByText(/There is no Arabic version yet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'استرداد إلى بطاقة مغلقة');

    await waitFor(
      async () => {
        const article = await apis.helpCenter.article('brand', M.articles.closedCard);
        expect(article.versions.map((row) => row.locale)).toEqual(['en', 'ar']);
      },
      { timeout: 4000 },
    );
  });

  it('exports this language as Markdown', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const { user } = await renderEditor();

    await user.click(screen.getByRole('button', { name: 'Export .md' }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    vi.unstubAllGlobals();
  });

  it('imports Markdown in place of this language’s text', async () => {
    const { user } = await renderEditor(M.articles.restocking);
    const input = document.querySelector('input[accept*=".md"]') as HTMLInputElement;
    const file = new File(['## Fees\n\nTen percent.'], 'fees.md', { type: 'text/markdown' });

    await act(async () => {
      await user.upload(input, file);
    });

    await screen.findByText('Markdown imported. It saves in a moment.');
    expect(screen.getByRole('textbox', { name: 'Article body' })).toHaveTextContent('Ten percent.');
  });

  it('says so when the article does not exist', async () => {
    const apis = await signedInMockApis();
    renderApp(<AppRoutes />, {
      authApi: apis.auth,
      staffApi: apis.staff,
      helpCenterApi: apis.helpCenter,
      initialEntries: [articleRoute('0193b000-0000-7000-8000-999999999999')],
    });

    expect(
      await screen.findByText('This article could not be opened.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});
