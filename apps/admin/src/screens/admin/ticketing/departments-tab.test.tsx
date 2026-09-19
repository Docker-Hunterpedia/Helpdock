import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { MockTicketingApi } from '../../../ticketing/mock-api.js';

/**
 * The Departments tab against the fixture. What is worth asserting is what the
 * screen decides — which control leads to which call, which confirmation is
 * asked for, which refusal becomes which sentence — rather than the markup it
 * decides it with.
 */

const renderDepartments = async (ticketingApi?: MockTicketingApi) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketingApi ?? ticketing,
    initialEntries: ['/admin/ticketing/departments'],
  });

  // The table element appears before its rows do; waiting for a row means a
  // query for the list is never racing the fixture.
  await screen.findByRole('button', { name: 'Edit Support' });

  return rendered;
};

/**
 * The name cell of each row, in order. Addressed as a cell rather than as "the
 * second button", so adding a control to the row cannot make this read the
 * wrong element and assert on the wrong text.
 */
const namesInOrder = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '');

describe('the list', () => {
  it('shows the brand’s departments with their counts', async () => {
    await renderDepartments();

    expect(await screen.findByRole('button', { name: 'Edit Support' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Billing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Onboarding' })).toBeInTheDocument();
  });

  it('shows the Arabic name under the Latin one', async () => {
    await renderDepartments();

    expect(await screen.findByText('الدعم')).toBeInTheDocument();
  });

  it('says nothing is selected until something is', async () => {
    await renderDepartments();

    expect(await screen.findByText(/Choose a department to edit/)).toBeInTheDocument();
  });
});

describe('creating', () => {
  it('adds a department and selects it', async () => {
    const { user } = await renderDepartments();

    await user.click(screen.getByRole('button', { name: 'Add department' }));
    await user.type(await screen.findByLabelText('Name'), 'Sales');
    await user.click(screen.getByRole('button', { name: 'Create department' }));

    expect(await screen.findByText('Sales added')).toBeInTheDocument();
  });

  it('turns a duplicate name into the sentence that names the rule', async () => {
    const { user } = await renderDepartments();

    await user.click(screen.getByRole('button', { name: 'Add department' }));
    await user.type(await screen.findByLabelText('Name'), 'Support');
    await user.click(screen.getByRole('button', { name: 'Create department' }));

    expect(await screen.findByText('That name is already taken.')).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('fills the side card from the row and saves a rename', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Edit Support' }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Front desk');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Front desk saved')).toBeInTheDocument();
  });

  it('opens the editor from the row menu as well as from the name', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Actions for Billing' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    expect(await screen.findByLabelText('Name')).toHaveValue('Billing');
  });

  it('offers the default team only once the department has one', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Edit Support' }));
    await user.click(screen.getByLabelText('Default team'));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Escape}');
    await user.type(await screen.findByLabelText('Team name'), 'Front line');
    await user.click(screen.getByRole('button', { name: 'Add team' }));

    await screen.findByText('Front line added');
    await user.click(screen.getByLabelText('Default team'));

    expect(await screen.findByRole('option', { name: 'Front line' })).toBeInTheDocument();
  });
});

describe('reordering', () => {
  it('moves a row down from the row menu and keeps the new order', async () => {
    const { user } = await renderDepartments();

    expect(namesInOrder()).toEqual(['Supportالدعم', 'Billingالفوترة', 'Onboardingالانضمام']);

    await user.click(await screen.findByRole('button', { name: 'Actions for Support' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));

    await screen.findByText('New order saved');
    await waitFor(() => {
      expect(namesInOrder()).toEqual(['Billingالفوترة', 'Supportالدعم', 'Onboardingالانضمام']);
    });
  });

  it('moves a row with the arrow keys on the drag handle itself', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Reorder Support' }));
    await user.keyboard('{ArrowDown}');

    await screen.findByText('New order saved');
    await waitFor(() => {
      expect(namesInOrder()[0]).toContain('Billing');
    });
  });

  it('does nothing at the top of the list', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Actions for Support' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));

    expect(namesInOrder()[0]).toContain('Support');
    expect(screen.queryByText('New order saved')).not.toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('asks before deleting and then deletes', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Actions for Billing' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByText('Delete Billing?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete department' }));

    expect(await screen.findByText('Billing deleted')).toBeInTheDocument();
  });

  it('leaves the department alone when the confirmation is dismissed', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Actions for Billing' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('button', { name: 'Edit Billing' })).toBeInTheDocument();
    expect(screen.queryByText('Billing deleted')).not.toBeInTheDocument();
  });

  it('refuses the last department in words a person can act on', async () => {
    const ticketing = new MockTicketingApi();
    const { departments } = await ticketing.departments('brand');
    for (const row of departments.slice(1)) {
      await ticketing.deleteDepartment('brand', row.id);
    }

    const { user } = await renderDepartments(ticketing);

    await user.click(await screen.findByRole('button', { name: 'Actions for Support' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete department' }));

    expect(await screen.findByText('A brand keeps at least one department.')).toBeInTheDocument();
  });
});

describe('a failure that is not a rule', () => {
  it('says so in one sentence rather than guessing at a reason', async () => {
    const ticketing = new MockTicketingApi();
    ticketing.createDepartment = () => Promise.reject(new Error('the api fell over'));

    const { user } = await renderDepartments(ticketing);

    await user.click(screen.getByRole('button', { name: 'Add department' }));
    await user.type(await screen.findByLabelText('Name'), 'Sales');
    await user.click(screen.getByRole('button', { name: 'Create department' }));

    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
  });
});

describe('teams', () => {
  it('adds a team, adds somebody to it, and takes them off again', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Edit Support' }));
    await user.type(await screen.findByLabelText('Team name'), 'Front line');
    await user.click(screen.getByRole('button', { name: 'Add team' }));
    await screen.findByText('Front line added');

    await user.click(screen.getByLabelText('Who to add to Front line'));
    await user.click(await screen.findByRole('option', { name: 'Yara Salem' }));
    expect(await screen.findByText('Yara Salem added to Front line')).toBeInTheDocument();

    await user.click(
      await screen.findByRole('button', { name: 'Remove Yara Salem from Front line' }),
    );
    expect(await screen.findByText('Yara Salem removed from Front line')).toBeInTheDocument();
  });

  it('renames a team from its row menu', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Edit Support' }));
    await user.type(await screen.findByLabelText('Team name'), 'Front line');
    await user.click(screen.getByRole('button', { name: 'Add team' }));
    await screen.findByText('Front line added');

    await user.click(await screen.findByRole('button', { name: 'Actions for Front line' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const form = await screen.findByRole('form', { name: 'New name for Front line' });
    const field = within(form).getByLabelText('New name for Front line');
    await user.clear(field);
    await user.type(field, 'Tier 1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Tier 1 saved')).toBeInTheDocument();
  });

  it('asks before deleting a team', async () => {
    const { user } = await renderDepartments();

    await user.click(await screen.findByRole('button', { name: 'Edit Support' }));
    await user.type(await screen.findByLabelText('Team name'), 'Front line');
    await user.click(screen.getByRole('button', { name: 'Add team' }));
    await screen.findByText('Front line added');

    await user.click(await screen.findByRole('button', { name: 'Actions for Front line' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete team' }));

    expect(await screen.findByText('Delete Front line?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete team' }));

    expect(await screen.findByText('Front line deleted')).toBeInTheDocument();
  });
});
