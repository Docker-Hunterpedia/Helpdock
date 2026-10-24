import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { keyFromLabel } from './custom-field-editor.tsx';

/**
 * The Custom fields tab against the fixture. The two rules that only exist
 * because values are already stored — a key that cannot move, and an option
 * that is in use — are what most of this covers.
 */

/**
 * The row of one table that contains `text`. A function that throws rather than
 * an optional chain, so a list that stopped rendering fails here instead of
 * turning the next assertion into a search of the whole document.
 */
const rowFor = (table: string, text: string): HTMLElement => {
  const row = within(screen.getByRole('table', { name: table }))
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(text) !== null);

  if (row === undefined) {
    throw new Error(`no row containing ${text} in ${table}`);
  }

  return row;
};

const renderFields = async () => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: ['/admin/ticketing/custom-fields'],
  });

  await screen.findByRole('button', { name: 'Edit Plan tier' });

  return rendered;
};

describe('keyFromLabel', () => {
  it.each([
    ['Plan tier', 'plan_tier'],
    ['Renews on!', 'renews_on'],
    ['  Seats  ', 'seats'],
    ['2026 plan', 'f2026_plan'],
  ])('suggests %s as %s', (label, key) => {
    expect(keyFromLabel(label)).toBe(key);
  });
});

describe('the lists', () => {
  it('draws one table per target, because they are three separate lists', async () => {
    await renderFields();

    expect(screen.getByRole('table', { name: 'Custom fields on a Ticket' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Custom fields on a Contact' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Custom fields on a Account' })).toBeInTheDocument();
  });

  it('prints the key, the type and whether it is required', async () => {
    await renderFields();

    const row = rowFor('Custom fields on a Ticket', 'tier');

    expect(within(row).getByText('Select')).toBeInTheDocument();
    expect(within(row).getByText('Yes')).toBeInTheDocument();
  });

  it('says which fields an agent does not see', async () => {
    await renderFields();

    const table = screen.getByRole('table', { name: 'Custom fields on a Contact' });
    expect(within(table).getByText('Admins only')).toBeInTheDocument();
  });
});

describe('creating', () => {
  it('suggests the key from the label until somebody types one', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Add ticket field' }));
    await user.type(await screen.findByLabelText('Label'), 'Renewal date');

    expect(screen.getByLabelText('Key')).toHaveValue('renewal_date');
  });

  it('stops following the label once the key has been typed in', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Add ticket field' }));
    await user.type(await screen.findByLabelText('Key'), 'renewal');
    await user.type(screen.getByLabelText('Label'), 'Something else');

    expect(screen.getByLabelText('Key')).toHaveValue('renewal');
  });

  it('adds a field and selects it', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Add ticket field' }));
    await user.type(await screen.findByLabelText('Label'), 'Escalation note');
    await user.click(screen.getByRole('button', { name: 'Create field' }));

    expect(await screen.findByText('Escalation note added')).toBeInTheDocument();
  });

  it('refuses a key the target already has', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Add ticket field' }));
    await user.type(await screen.findByLabelText('Label'), 'Tier');
    await user.click(screen.getByRole('button', { name: 'Create field' }));

    expect(await screen.findByText('That name is already taken.')).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('locks the key and says why', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));

    expect(await screen.findByLabelText('Key')).toBeDisabled();
    expect(screen.getByText(/key is fixed once the field exists/)).toBeInTheDocument();
  });

  it('refuses a type change while rows carry a value, and says which rule refused', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.click(await screen.findByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Text' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Rows already carry values for this field/)).toBeInTheDocument();
  });
});

describe('pinning a field (M14-16)', () => {
  const pinBox = () =>
    screen.queryByRole('checkbox', { name: 'Pin on rows and the ticket header' });

  it('offers the pin for a ticket select that Agents see, and for no other field', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    expect(await screen.findByLabelText('Key')).toBeDisabled();
    expect(pinBox()).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Visible to agents' }));
    expect(pinBox()).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Order id' }));
    expect(await screen.findByLabelText('Key')).toHaveValue('order_id');
    expect(pinBox()).not.toBeInTheDocument();
  });

  it('pins a field and marks its row', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.click(
      await screen.findByRole('checkbox', { name: 'Pin on rows and the ticket header' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Pinned')).toBeInTheDocument();
    expect(
      within(rowFor('Custom fields on a Ticket', 'tier')).getByText('Pinned'),
    ).toBeInTheDocument();
  });

  it('does not send the pin when only the label changed', async () => {
    const { user, ticketingApi } = await renderFields();
    const update = vi.spyOn(ticketingApi, 'updateCustomField');

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.type(await screen.findByLabelText('Label'), ' (v2)');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Plan tier (v2) saved')).toBeInTheDocument();
    expect(update.mock.calls[0]?.[2]).not.toHaveProperty('pinned');
  });
});

describe('the option list', () => {
  it('reorders an option from the keyboard alone', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    const first = await screen.findByRole('textbox', { name: 'Option 1' });
    expect(first).toHaveValue('gold');

    first.focus();
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('textbox', { name: 'Option 1' })).toHaveValue('silver');
    expect(screen.getByRole('textbox', { name: 'Option 2' })).toHaveValue('gold');
  });

  it('adds an option', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.click(await screen.findByRole('button', { name: 'Add option' }));

    expect(screen.getByRole('textbox', { name: 'Option 4' })).toBeInTheDocument();
  });

  it('asks before removing an option rows still carry, rather than failing', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.click(await screen.findByRole('button', { name: 'Remove gold' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/clears the option from them/)).toBeInTheDocument();
  });

  it('sends the same edit again with force once the question is answered', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.click(await screen.findByRole('button', { name: 'Remove gold' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove anyway' }),
    );

    expect(await screen.findByText('Plan tier saved')).toBeInTheDocument();
  });

  it('removes an option nothing carries without asking', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Edit Plan tier' }));
    await user.click(await screen.findByRole('button', { name: 'Remove bronze' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Plan tier saved')).toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('says how many rows carry a value before it asks', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Actions for Plan tier' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/7 rows carry a value/)).toBeInTheDocument();
  });

  it('deletes when the confirmation is accepted', async () => {
    const { user } = await renderFields();

    await user.click(screen.getByRole('button', { name: 'Actions for Renews on' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete field' }),
    );

    expect(await screen.findByText('Renews on deleted')).toBeInTheDocument();
  });
});
