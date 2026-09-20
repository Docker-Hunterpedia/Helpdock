import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Tags tab against the fixture. What is worth asserting is what the screen
 * decides — which control leads to which call, what the confirmation says, and
 * which refusal becomes which sentence — rather than the markup it decides with.
 */

const renderTags = async () => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: ['/admin/ticketing/tags'],
  });

  await screen.findByRole('button', { name: 'Edit Refund' });

  return rendered;
};

/**
 * The row carrying this tag. A function that throws rather than an optional
 * chain, so a list that stopped rendering fails here instead of turning the
 * next assertion into a search of the whole document.
 */
const rowFor = (name: string): HTMLElement => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryAllByText(name).length > 0);

  if (row === undefined) {
    throw new Error(`no row for the tag ${name}`);
  }

  return row;
};

/** The tag name of each row, in order. Addressed as a cell, not as "a button". */
const namesInOrder = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[2]?.textContent ?? '');

describe('the list', () => {
  it('shows the brand’s tags with how many tickets carry them', async () => {
    await renderTags();

    expect(screen.getByRole('button', { name: 'Edit VIP' })).toBeInTheDocument();
    expect(within(rowFor('Refund')).getByText('12')).toBeVisible();
  });

  it('shows the Arabic name in its own column', async () => {
    await renderTags();

    expect(screen.getByText('استرداد')).toBeInTheDocument();
  });

  it('says nothing is selected until something is', async () => {
    await renderTags();

    expect(screen.getByText(/Choose a tag to edit/)).toBeInTheDocument();
  });
});

describe('creating', () => {
  it('adds a tag and selects it', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    await user.type(await screen.findByLabelText('Name'), 'Chargeback');
    await user.click(screen.getByRole('button', { name: 'Create tag' }));

    expect(await screen.findByText('Chargeback added')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Chargeback' })).toBeInTheDocument();
  });

  it('turns a duplicate name into the sentence that names the rule', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    await user.type(await screen.findByLabelText('Name'), 'refund');
    await user.click(screen.getByRole('button', { name: 'Create tag' }));

    // The unique index compares case-insensitively; so does the fixture.
    expect(await screen.findByText('That name is already taken.')).toBeInTheDocument();
  });
});

describe('the colour picker', () => {
  it('offers the eight tints of DESIGN §6.2 as radio buttons', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    // Real radios with names, so the choice is reachable by keyboard and is
    // never carried by colour alone.
    expect(await screen.findAllByRole('radio')).toHaveLength(8);
    expect(screen.getByRole('radio', { name: 'Violet' })).toBeInTheDocument();
  });

  it('never offers the danger tint, which means breached on this desk', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    expect(screen.queryByRole('radio', { name: /red/i })).not.toBeInTheDocument();
  });

  it('saves the colour the radio group holds', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Edit Bug' }));
    await user.click(await screen.findByRole('radio', { name: 'Green' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Bug saved')).toBeInTheDocument();
  });
});

describe('reordering', () => {
  it('moves a tag with the arrow keys on its handle', async () => {
    const { user } = await renderTags();

    expect(namesInOrder()).toEqual(['Refund', 'VIP', 'Bug']);

    await user.click(screen.getByRole('button', { name: 'Reorder Refund' }));
    await user.keyboard('{ArrowDown}');

    expect(await screen.findByText('New tag order saved')).toBeInTheDocument();
    expect(namesInOrder()).toEqual(['VIP', 'Refund', 'Bug']);
  });

  it('moves one from the row menu, which sends the same whole list', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Actions for Bug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));

    expect(await screen.findByText('New tag order saved')).toBeInTheDocument();
    expect(namesInOrder()).toEqual(['Refund', 'Bug', 'VIP']);
  });
});

describe('deleting', () => {
  it('says how many tickets keep no tag before it asks', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Actions for Refund' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/12 tickets keep no tag/)).toBeInTheDocument();
  });

  it('still asks when the tag is on nothing, and says so', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Actions for Bug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/0 tickets keep no tag/)).toBeInTheDocument();
  });

  it('detaches the tag when the confirmation is accepted', async () => {
    const { user } = await renderTags();

    await user.click(screen.getByRole('button', { name: 'Actions for Bug' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete tag' }),
    );

    expect(await screen.findByText('Bug deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Bug' })).not.toBeInTheDocument();
  });
});
