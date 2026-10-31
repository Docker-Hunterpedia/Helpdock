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
    initialEntries: ['/settings/inbox/macros'],
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

describe('the shortcut and the save-time check (M14-14)', () => {
  it('shows the shortcut in the list and in the editor', async () => {
    const { user } = await renderMacros();

    expect(screen.getByText('/shipping')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Shipping fees explained/ }));

    expect(screen.getByLabelText('Shortcut')).toHaveValue('shipping');
  });

  it('saves a shortcut typed with the slash, lower-cased, and clears it when emptied', async () => {
    const { user, apis } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Ask for the order number/ }));

    await user.type(screen.getByLabelText('Shortcut'), '/Order');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Ask for the order number saved.')).toBeInTheDocument();
    let saved = (await apis.ticketing.macros('brand')).macros.find(
      (macro) => macro.name === 'Ask for the order number',
    );
    expect(saved?.shortcut).toBe('order');

    await user.clear(screen.getByLabelText('Shortcut'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(async () => {
      saved = (await apis.ticketing.macros('brand')).macros.find(
        (macro) => macro.name === 'Ask for the order number',
      );
      expect(saved?.shortcut).toBeNull();
    });
  });

  it('says on the field when another item has the shortcut, and keeps the draft', async () => {
    const { user, apis } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Ask for the order number/ }));

    await user.type(screen.getByLabelText('Shortcut'), 'shipping');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Another saved reply or macro already uses that shortcut.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Shortcut')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Shortcut')).toHaveValue('shipping');
    const { macros } = await apis.ticketing.macros('brand');
    expect(macros.find((macro) => macro.name === 'Ask for the order number')?.shortcut).toBeNull();

    // Changing it clears the complaint.
    await user.type(screen.getByLabelText('Shortcut'), '2');
    expect(
      screen.queryByText('Another saved reply or macro already uses that shortcut.'),
    ).not.toBeInTheDocument();
  });

  it('refuses a shortcut with a space in it before it is sent', async () => {
    const { user } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Ask for the order number/ }));

    await user.type(screen.getByLabelText('Shortcut'), 'two words');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      screen.getAllByText('A shortcut is one word: letters, digits, - and _.').length,
    ).toBeGreaterThan(0);
  });

  it('names an unknown placeholder, suggests the nearest, and will not save it', async () => {
    const { user, apis } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Ask for the order number/ }));

    const english = screen.getByLabelText('English');
    await user.clear(english);
    await user.type(english, 'Thanks, {{{{agent.nmae}}');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Unknown placeholder {{agent.nmae}}.');
    expect(alert).toHaveTextContent('Did you mean {{agent.name}}?');
    expect(english).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      screen.getAllByText('Fix the placeholders listed under the reply.').length,
    ).toBeGreaterThan(0);
    const { macros } = await apis.ticketing.macros('brand');
    expect(macros.find((macro) => macro.name === 'Ask for the order number')?.bodies.en).toContain(
      'order number',
    );
  });

  it('names an unclosed {{, and accepts a fallback', async () => {
    const { user } = await renderMacros();
    await user.click(screen.getByRole('button', { name: /Ask for the order number/ }));

    const english = screen.getByLabelText('English');
    await user.clear(english);
    await user.type(english, 'Hi {{{{contact.first_name');
    expect(screen.getByRole('alert')).toHaveTextContent('Unclosed {{contact.first_name');

    await user.type(english, '|there}}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
