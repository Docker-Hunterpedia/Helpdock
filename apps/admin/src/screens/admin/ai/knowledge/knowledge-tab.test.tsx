import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../../app/routes.tsx';
import { leaveTo } from '../../../../knowledge/leave.js';
import { MockKnowledgeApi } from '../../../../knowledge/mock-api.js';
import { renderApp } from '../../../../test/render.tsx';
import { signedInMockApis } from '../../../../test/signed-in.js';

/**
 * AI › Knowledge (`Admin/AI-Knowledge`) against the fixture: the seven
 * sources and their states, "Sync now", a crawl and a file added through the
 * dialog, connecting Drive, the drawer with its translated sync log and
 * visibility, and removal.
 */

vi.mock('../../../../knowledge/leave.js', () => ({ leaveTo: vi.fn() }));

const renderKnowledge = async (
  knowledgeApi = new MockKnowledgeApi(),
  path = '/admin/ai/knowledge',
) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    knowledgeApi,
    initialEntries: [path],
  });
  await screen.findByRole('table', { name: 'Knowledge sources' });
  return { ...rendered, knowledgeApi };
};

const rowOf = (name: string): HTMLElement => {
  const row = within(screen.getByRole('table', { name: 'Knowledge sources' }))
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return row;
};

beforeEach(() => {
  vi.mocked(leaveTo).mockClear();
});

describe('AI › Knowledge', () => {
  it('lists every source with its visibility, schedule and state in words', async () => {
    await renderKnowledge();

    expect(within(rowOf('Help center articles')).getByText('Per article')).toBeVisible();
    expect(within(rowOf('Help center articles')).getByText('On publish')).toBeVisible();
    expect(within(rowOf('docs.helpdock.io')).getByText('Syncing 260 / 520')).toBeVisible();
    expect(
      within(rowOf('docs.helpdock.io')).getByRole('progressbar', {
        name: 'Sync progress of docs.helpdock.io',
      }),
    ).toHaveAttribute('aria-valuenow', '50');
    expect(
      within(rowOf('partners.helpdock.io')).getByText(/resolves to a private address/),
    ).toBeVisible();
    expect(
      within(rowOf('Notion · Support playbook')).getByRole('button', { name: 'Reconnect' }),
    ).toBeVisible();
  });

  it('queues a sync, and filters the sources by name', async () => {
    const { user } = await renderKnowledge();

    await user.click(
      within(rowOf('Billing FAQ.pdf')).getByRole('button', { name: 'Sync Billing FAQ.pdf now' }),
    );
    expect(await screen.findByText('Sync of Billing FAQ.pdf queued.')).toBeVisible();
    expect(within(rowOf('Billing FAQ.pdf')).getByText('Queued')).toBeVisible();

    await user.type(screen.getByRole('searchbox', { name: 'Search sources' }), 'drive');
    expect(
      within(screen.getByRole('table', { name: 'Knowledge sources' })).getAllByRole('row'),
    ).toHaveLength(2);
  });

  it('adds a crawl, refusing a bad address first', async () => {
    const { user, knowledgeApi } = await renderKnowledge();
    const create = vi.spyOn(knowledgeApi, 'createSource');

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add knowledge source' });
    const url = within(dialog).getByLabelText('Sitemap URL');
    fireEvent.change(url, { target: { value: 'not a url' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add and start crawl' }));
    expect(
      within(dialog).getByText('Enter an address starting with http:// or https://.'),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(url, { target: { value: 'https://help.acme.test/sitemap.xml' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add and start crawl' }));

    expect(create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: 'crawl',
        visibility: 'internal',
        config: expect.objectContaining({ maxPages: 600 }),
      }),
    );
    expect(await screen.findByText('help.acme.test added.')).toBeVisible();
  });

  it('uploads a file through the dialog, one source per file', async () => {
    const { user, knowledgeApi } = await renderKnowledge();
    const upload = vi.spyOn(knowledgeApi, 'uploadFile');

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add knowledge source' });
    await user.click(within(dialog).getByRole('radio', { name: /Files/ }));
    const file = new File(['# Returns'], 'returns.md', { type: 'text/markdown' });
    await user.upload(within(dialog).getByLabelText('Files'), file);
    await user.click(within(dialog).getByRole('radio', { name: /^Public/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Upload and index' }));

    expect(upload).toHaveBeenCalledWith(expect.any(String), file, 'public');
    expect(await screen.findByText('1 file uploaded.')).toBeVisible();
    await waitFor(() => {
      expect(rowOf('returns.md')).toBeVisible();
    });
  });

  it('sends the browser to Google to connect a new Drive source, and says when the install cannot', async () => {
    const { user } = await renderKnowledge();

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add knowledge source' });
    await user.click(within(dialog).getByRole('radio', { name: /Google Drive/ }));
    await user.type(within(dialog).getByLabelText('Name'), 'Policies');
    await user.click(within(dialog).getByRole('button', { name: 'Add and connect' }));

    await waitFor(() => {
      expect(leaveTo).toHaveBeenCalledWith(expect.stringContaining('oauth=connected'));
    });
  });

  it('refuses Drive on an install without the OAuth app', async () => {
    const { user } = await renderKnowledge(
      new MockKnowledgeApi({ oauth: { notion: false, gdrive: false } }),
    );

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add knowledge source' });
    await user.click(within(dialog).getByRole('radio', { name: /Google Drive/ }));

    expect(within(dialog).getByText(/no OAuth app for this service/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Add and connect' })).toBeDisabled();
  });

  it('opens the drawer with the translated sync log, and changes visibility there', async () => {
    const { user, knowledgeApi } = await renderKnowledge();
    const update = vi.spyOn(knowledgeApi, 'updateSource');

    await user.click(
      within(rowOf('docs.helpdock.io')).getByRole('button', { name: 'docs.helpdock.io' }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'docs.helpdock.io' });
    const log = await within(drawer).findByRole('list', { name: 'Sync log of docs.helpdock.io' });
    expect(within(log).getByText('Sitemap read · 538 URLs, 520 after patterns')).toBeVisible();
    expect(within(log).getByText('/docs/legacy/api skipped: the page returned 404')).toBeVisible();

    await user.click(within(drawer).getByRole('combobox', { name: 'Visibility' }));
    await user.click(await screen.findByRole('option', { name: 'Internal' }));
    expect(update).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      visibility: 'internal',
    });
  });

  it('removes a source after saying what goes', async () => {
    const { user } = await renderKnowledge();

    await user.click(
      within(rowOf('Billing FAQ.pdf')).getByRole('button', { name: 'More for Billing FAQ.pdf' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Remove source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove “Billing FAQ.pdf”?' });
    expect(within(dialog).getByText(/Its 38 chunks are deleted immediately/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }));

    expect(await screen.findByText('Billing FAQ.pdf removed.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Billing FAQ.pdf' })).toBeNull();
  });

  it('says when a Notion or Drive connection did not complete', async () => {
    await renderKnowledge(new MockKnowledgeApi(), '/admin/ai/knowledge?oauth=failed');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The connection was not completed. Try Connect again.',
    );
  });
});
