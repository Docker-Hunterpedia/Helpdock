import type { AuditLogQuery } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { AuditLogPage } from './audit-log-page.tsx';
import { auditLogPage, fakeSystemApi } from './fixtures.js';
import { NotAllowedError } from './system-api.js';

/**
 * The audit log page (M3-08) against a fake api answering the artboard's rows.
 * The api redacts; what is asserted here is that the page asks for what the
 * filters say, pages by the cursor it was given, and draws what it was handed.
 */

type Query = Partial<Omit<AuditLogQuery, 'limit'>>;

const renderPage = () => {
  const auditLog = vi.fn(async (_query: Query) => auditLogPage());
  const rendered = renderApp(<AuditLogPage api={fakeSystemApi({ auditLog })} />);

  return { ...rendered, auditLog };
};

describe('AuditLogPage', () => {
  it('draws every row with its actor, action, target, brand and address', async () => {
    renderPage();

    const table = await screen.findByRole('table', { name: 'Audit entries' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(within(table).getByText('Omar Nasser')).toBeInTheDocument();
    expect(within(table).getByText('Acme Store')).toBeInTheDocument();
    expect(within(table).getAllByText('Install').length).toBeGreaterThan(0);
    expect(within(table).getByText('34.201.18.7')).toBeInTheDocument();
    expect(within(table).getByText('api key')).toBeInTheDocument();
  });

  it('expands a row into its diff, showing a secret only as changed', async () => {
    const { user } = renderPage();

    const toggle = await screen.findByRole('button', { name: /Details for settings.updated/ });
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: /Changes in settings.updated/ });
    expect(within(region).getByText('4 fields changed')).toBeInTheDocument();
    expect(within(region).getByText(/via admin UI · Firefox on Ubuntu/)).toBeInTheDocument();
    expect(within(region).getByText('smtp.helpdock.com')).toBeInTheDocument();
    expect(within(region).getAllByText('[redacted]')).toHaveLength(2);
    expect(within(region).getByText('Secret: changed, value never recorded')).toBeInTheDocument();
  });

  it('asks again with the filters, and from the first page', async () => {
    const { user, auditLog } = renderPage();
    await screen.findByRole('table', { name: 'Audit entries' });

    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(screen.getByRole('option', { name: 'macro.*' }));
    await user.click(screen.getByRole('combobox', { name: 'Brand' }));
    await user.click(screen.getByRole('option', { name: 'Install' }));

    await waitFor(() => {
      expect(auditLog).toHaveBeenLastCalledWith({ action: 'macro.*', brand: 'install' });
    });

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(auditLog).toHaveBeenLastCalledWith({});
    });
  });

  it('pages older by the cursor and back newer', async () => {
    const { user, auditLog } = renderPage();
    await screen.findByRole('table', { name: 'Audit entries' });
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => {
      expect(auditLog).toHaveBeenLastCalledWith({ cursor: 'older-page' });
    });

    await user.click(screen.getByRole('button', { name: 'Newer' }));
    await waitFor(() => {
      expect(auditLog).toHaveBeenLastCalledWith({});
    });
  });

  it('says so when nothing matches, and offers to clear the filters', async () => {
    const auditLog = vi.fn(async (query: Query) =>
      auditLogPage(query.actor === undefined ? {} : { entries: [], nextCursor: null }),
    );
    const { user } = renderApp(<AuditLogPage api={fakeSystemApi({ auditLog })} />);
    await screen.findByRole('table', { name: 'Audit entries' });

    await user.type(screen.getByRole('searchbox', { name: 'Actor' }), 'nobody');

    expect(await screen.findByRole('heading', { name: 'No matches' })).toBeInTheDocument();
    await user.click(
      screen.getAllByRole('button', { name: 'Clear filters' }).at(-1) as HTMLElement,
    );
    expect(await screen.findByRole('table', { name: 'Audit entries' })).toBeInTheDocument();
  });

  it('draws a refusal as "Not allowed"', async () => {
    renderApp(
      <AuditLogPage
        api={fakeSystemApi({
          auditLog: async () => {
            throw new NotAllowedError();
          },
        })}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeInTheDocument();
  });

  it('offers the way back to System', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: 'Back to System' })).toHaveAttribute(
      'href',
      '/admin/system',
    );
  });
});
