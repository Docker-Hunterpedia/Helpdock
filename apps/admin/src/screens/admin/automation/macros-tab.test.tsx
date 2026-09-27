import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Macros tab of Automation against the fixture, which seeds the rows of
 * the artboard `AdminAutomationMacros`.
 */

const renderMacros = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    initialEntries: ['/admin/automation/macros'],
  });

  await screen.findByRole('button', { name: /Refund issued/ });

  return { ...rendered, apis };
};

describe('the list', () => {
  it('shows each item with its kind, actions and languages', async () => {
    await renderMacros();

    expect(screen.getByText('Macro · 3 actions · EN AR')).toBeInTheDocument();
    expect(screen.getByText('Macro · 2 actions · no reply')).toBeInTheDocument();
    expect(screen.getByText('Canned response · EN only')).toBeInTheDocument();
    expect(screen.getByText(/7 of 7 · Personal items/)).toBeInTheDocument();
  });

  it('narrows by kind and by text', async () => {
    const { user } = await renderMacros();

    await user.click(screen.getByRole('button', { name: 'Canned' }));
    expect(screen.queryByRole('button', { name: /Refund issued/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Canned' })).toHaveAttribute('aria-pressed', 'true');

    await user.type(screen.getByRole('searchbox', { name: /Search macros/ }), 'order');
    expect(screen.getByText(/1 of 7/)).toBeInTheDocument();
  });
});

describe('the editor', () => {
  it('opens an item with its reply, preview and actions', async () => {
    const { user } = await renderMacros();

    await user.click(screen.getByRole('button', { name: /Refund issued/ }));

    const form = screen.getByRole('form', { name: 'Refund issued' });
    expect(within(form).getByLabelText(/^Name/)).toHaveValue('Refund issued');
    expect(within(form).getByText(/Preview · English:/)).toBeInTheDocument();
    expect(within(form).getByText(/Hi Mona,/)).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: 'Action 3' })).toBeInTheDocument();
  });

  it('inserts a placeholder from the picker, by keyboard', async () => {
    const { user } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Ask for the order number/ }));
    const form = screen.getByRole('form', { name: 'Ask for the order number' });

    const english = within(form).getByLabelText('English');
    await user.clear(english);
    await user.click(
      within(form).getAllByRole('button', { name: 'Placeholder' })[0] as HTMLElement,
    );
    const search = screen.getByRole('combobox', { name: 'Find a placeholder' });
    await user.type(search, 'number');
    await user.keyboard('{Enter}');

    expect(english).toHaveValue('{{ticket.number}}');
    expect(screen.queryByRole('listbox', { name: 'Placeholders' })).not.toBeInTheDocument();
  });

  it('refuses to save a macro with an unfinished action, and says why', async () => {
    const { user } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Close as duplicate/ }));

    await user.click(screen.getByRole('button', { name: 'Add action' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose a value for every action, or remove it.',
    );
  });

  it('saves a change and says so', async () => {
    const { user, apis } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Password reset steps/ }));

    const name = screen.getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Reset your password');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Reset your password saved.')).toBeInTheDocument();
    const { macros } = await apis.ticketing.macros('brand');
    expect(macros.map((macro) => macro.name)).toContain('Reset your password');
  });

  it('creates a personal canned response', async () => {
    const { user, apis } = await renderMacros();

    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'Canned response' }));
    const form = screen.getByRole('form', { name: 'New canned response' });
    expect(within(form).queryByRole('group', { name: /Actions/ })).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText(/^Name/), 'Thanks');
    await user.type(within(form).getByLabelText('English'), 'Thank you, {{{{contact.first_name}}!');
    await user.click(within(form).getByRole('combobox', { name: 'Scope' }));
    await user.click(screen.getByRole('option', { name: 'Personal · only me' }));
    await user.click(within(form).getByRole('button', { name: 'Create' }));

    await waitFor(async () => {
      const { macros } = await apis.ticketing.macros('brand');
      expect(macros.find((macro) => macro.name === 'Thanks')).toMatchObject({
        scope: 'personal',
        bodies: { en: 'Thank you, {{contact.first_name}}!' },
      });
    });
  });

  it('duplicates an item into a new, unsaved one', async () => {
    const { user } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Hand to finance/ }));

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    expect(screen.getByLabelText(/^Name/)).toHaveValue('Hand to finance (copy)');
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('deletes after asking', async () => {
    const { user } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Shipping fees explained/ }));

    await user.click(screen.getByRole('button', { name: 'Delete Shipping fees explained' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Shipping fees explained deleted.')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Shipping fees explained/ }),
      ).not.toBeInTheDocument();
    });
  });
});

describe('the Automation page', () => {
  it('shows the rules tabs as not built yet', async () => {
    const apis = await signedInMockApis();
    renderApp(<AppRoutes />, {
      authApi: apis.auth,
      staffApi: apis.staff,
      ticketingApi: apis.ticketing,
      ticketsApi: apis.tickets,
      initialEntries: ['/admin/automation'],
    });

    expect(await screen.findByText(/Rules arrives with deliverable M3-05/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Macros' })).toBeInTheDocument();
  });
});
