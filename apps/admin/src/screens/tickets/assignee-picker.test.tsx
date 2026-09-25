import type { AssignableAgent } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { AssigneePicker, matchesSearch } from './assignee-picker.tsx';

/**
 * The assignee picker of the details panel (M1-07). What the screen decides is
 * what each option says — presence, load, at cap — and which choice leads to
 * which call; the rest is MUI's.
 */

const LINA = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
const SAMI = '0192c3f0-1a2b-7c3d-8e4f-00000000000f';

const agents: AssignableAgent[] = [
  { userId: LINA, name: 'Lina Haddad', presence: 'online', openCount: 3 },
  { userId: OMAR, name: 'Omar Nasser', presence: 'online', openCount: 8 },
  { userId: SAMI, name: 'Sami Aziz', presence: 'offline', openCount: 0 },
];

const renderPicker = (props: Partial<Parameters<typeof AssigneePicker>[0]> = {}) => {
  const onChange = vi.fn();
  const rendered = renderApp(
    <AssigneePicker
      id="assignee"
      label="Assignee"
      assigneeId={LINA}
      assigneeName="Lina Haddad"
      agents={agents}
      loadCap={8}
      departmentName="Support"
      unavailable={false}
      busy={false}
      onChange={onChange}
      {...props}
    />,
  );

  return { ...rendered, onChange };
};

describe('matchesSearch', () => {
  it('matches any part of the name, whatever the case', () => {
    expect(matchesSearch('Omar Nasser', 'nass')).toBe(true);
    expect(matchesSearch('Omar Nasser', '  OMAR ')).toBe(true);
    expect(matchesSearch('Omar Nasser', 'lina')).toBe(false);
  });
});

describe('AssigneePicker', () => {
  it('names the assignee on the button, and "Unassigned" when there is none', () => {
    renderPicker();
    expect(screen.getByRole('button', { name: 'Assignee: Lina Haddad' })).toBeInTheDocument();
  });

  it('says so when nobody is assigned', () => {
    renderPicker({ assigneeId: null, assigneeName: null });
    expect(screen.getByRole('button', { name: 'Assignee: Unassigned' })).toBeInTheDocument();
  });

  it('lists load against the cap, at cap in its own words, and offline instead of a count', async () => {
    const { user } = renderPicker();
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));

    expect(await screen.findByRole('option', { name: /Lina Haddad\s*3\/8/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: /Omar Nasser\s*8\/8 at cap/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Sami Aziz\s*offline/ })).toBeInTheDocument();
    expect(screen.getByText(/Agents in Support/)).toBeInTheDocument();
  });

  it('lets an agent at cap be picked by hand', async () => {
    const { user, onChange } = renderPicker();
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));
    await user.click(await screen.findByRole('option', { name: /Omar Nasser/ }));

    expect(onChange).toHaveBeenCalledWith(OMAR);
  });

  it('unassigns, and does nothing when the choice is the current one', async () => {
    const { user, onChange } = renderPicker();
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));
    await user.click(await screen.findByRole('option', { name: /Lina Haddad/ }));
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));
    await user.click(await screen.findByRole('option', { name: 'Unassigned' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('narrows the list as somebody types, and says when nothing matches', async () => {
    const { user } = renderPicker();
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));
    await user.type(await screen.findByRole('searchbox', { name: 'Find an agent' }), 'sami');

    expect(screen.queryByRole('option', { name: /Omar Nasser/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Sami Aziz/ })).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Find an agent' }), 'zzz');
    expect(screen.getByRole('option', { name: 'No agent matches' })).toBeInTheDocument();
  });

  it('moves from the search into the list with the arrow key', async () => {
    const { user } = renderPicker();
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));
    await screen.findByRole('searchbox', { name: 'Find an agent' });
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('option', { name: 'Unassigned' })).toHaveFocus();
  });

  it('says the read failed rather than looking empty', async () => {
    const { user } = renderPicker({ agents: [], unavailable: true });
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));

    expect(
      await screen.findByRole('option', { name: 'Could not load who can take this ticket.' }),
    ).toBeInTheDocument();
  });

  it('prints a bare count when the department has no cap', async () => {
    const { user } = renderPicker({ loadCap: null });
    await user.click(screen.getByRole('button', { name: 'Assignee: Lina Haddad' }));

    expect(await screen.findByRole('option', { name: /Omar Nasser\s*8$/ })).toBeInTheDocument();
  });
});
