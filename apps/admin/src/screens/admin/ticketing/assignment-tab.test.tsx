import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { TicketingError } from '../../../ticketing/api.js';
import { atCap } from './assignment-agents.tsx';
import { parseWhole } from './assignment-editor.tsx';

/**
 * The Assignment tab against the fixture (M1-07). What is asserted is what the
 * screen decides: which department is being edited, what a row says about its
 * load and rotation, which control leads to which call, and which input the
 * editor refuses to send.
 */

const renderAssignment = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    initialEntries: ['/admin/ticketing/assignment'],
  });

  await screen.findByRole('button', { name: 'Edit Support' });
  // The agents are a second read; every test below is about a drawn screen.
  await screen.findByRole('checkbox', { name: 'Omar Nasser in rotation' });

  return { ...rendered, ticketing: apis.ticketing };
};

const rowFor = (name: string): HTMLElement => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryAllByText(name).length > 0);
  if (row === undefined) {
    throw new Error(`no row for ${name}`);
  }

  return row;
};

describe('parseWhole', () => {
  it('reads an empty box as null, which is "no cap"', () => {
    expect(parseWhole('  ', 500)).toBeNull();
  });

  it('reads a whole number in range and refuses anything else', () => {
    expect(parseWhole('8', 500)).toBe(8);
    expect(parseWhole('0', 500)).toBeUndefined();
    expect(parseWhole('501', 500)).toBeUndefined();
    expect(parseWhole('2.5', 500)).toBeUndefined();
    expect(parseWhole('eight', 500)).toBeUndefined();
  });
});

describe('atCap', () => {
  it('is full at the cap and never with no cap', () => {
    expect(atCap(8, 8)).toBe(true);
    expect(atCap(7, 8)).toBe(false);
    expect(atCap(99, null)).toBe(false);
  });
});

describe('the departments', () => {
  it('lists how each department routes, and opens on the first', async () => {
    await renderAssignment();

    const support = rowFor('Support');
    expect(within(support).getByText('Round-robin')).toBeVisible();
    expect(within(support).getByText('15 min')).toBeVisible();
    expect(within(rowFor('Onboarding')).getByText('off')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Assignment · Support' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agents in Support' })).toBeInTheDocument();
  });

  it('switches the editor and the agents to the department chosen', async () => {
    const { user } = await renderAssignment();

    await user.click(screen.getByRole('button', { name: 'Edit Billing' }));

    expect(
      await screen.findByRole('heading', { name: 'Assignment · Billing' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Skill-based/ })).toBeChecked();
  });
});

describe('the editor', () => {
  it('saves the settings and says so', async () => {
    const { user } = await renderAssignment();

    await user.click(screen.getByRole('radio', { name: /^Manual/ }));
    const cap = screen.getByLabelText('Load cap per agent');
    await user.clear(cap);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Support saved')).toBeInTheDocument();
    expect(within(rowFor('Support')).getByText('Manual')).toBeVisible();
    expect(within(rowFor('Support')).getByText('—')).toBeVisible();
  });

  it('refuses a cap that is not a whole number from one to 500', async () => {
    const { user } = await renderAssignment();

    const cap = screen.getByLabelText('Load cap per agent');
    await user.clear(cap);
    await user.type(cap, '0');

    expect(screen.getByText(/Enter a whole number from 1 to 500/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('checks the minutes only while the timer is on', async () => {
    const { user } = await renderAssignment();

    const minutes = screen.getByRole('textbox', { name: 'Minutes offline' });
    await user.clear(minutes);
    expect(screen.getByText(/Enter a whole number of minutes/)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Unassign when the agent is offline/ }));
    expect(screen.queryByText(/Enter a whole number of minutes/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('puts the card back to what is saved on Cancel', async () => {
    const { user } = await renderAssignment();

    await user.click(screen.getByRole('radio', { name: /^Manual/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('radio', { name: /^Round-robin/ })).toBeChecked();
  });

  it('turns a refusal into the sentence that names the rule', async () => {
    const { user, ticketing } = await renderAssignment();
    ticketing.updateAssignment = () => Promise.reject(new TicketingError('out-of-scope'));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('You do not lead that department.')).toBeInTheDocument();
  });
});

describe('the agents', () => {
  it('draws presence, load against the cap, and who is in rotation', async () => {
    await renderAssignment();

    const omar = rowFor('Omar Nasser');
    expect(within(omar).getByText('8 / 8 · at cap')).toBeVisible();
    expect(within(rowFor('Yara Salem')).getByText('Away')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Omar Nasser in rotation' })).toBeChecked();
    // An Admin with no stored choice is out of rotation.
    expect(screen.getByRole('checkbox', { name: 'Lina Haddad in rotation' })).not.toBeChecked();
  });

  it('takes somebody out of rotation', async () => {
    const { user } = await renderAssignment();

    await user.click(screen.getByRole('checkbox', { name: 'Sami Aziz in rotation' }));

    expect(await screen.findByText('Sami Aziz updated')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Sami Aziz in rotation' })).not.toBeChecked();
  });

  it('adds a skill from the brand tags and removes one', async () => {
    const { user } = await renderAssignment();

    await user.click(screen.getByRole('button', { name: 'Add skill for Sami Aziz' }));
    await user.click(await screen.findByRole('menuitem', { name: 'VIP' }));
    expect(await screen.findByText('Sami Aziz updated')).toBeInTheDocument();
    expect(within(rowFor('Sami Aziz')).getByText('VIP')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove Refund from Yara Salem' }));
    expect(await screen.findByText('Yara Salem updated')).toBeInTheDocument();
  });
});
