import type { ContactSummary, Department } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { NewTicketDialog, type NewTicketValue } from './new-ticket-dialog.tsx';

/**
 * The dialog on its own, because what it owns is the form: which fields are
 * required, what an address has to look like, and which of the three kinds of
 * contact the screen is told to file the ticket against.
 */

const DEPARTMENTS: Department[] = [
  { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1', name: 'Support' },
  { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000d2', name: 'Billing' },
];

const MONA = {
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1',
  name: 'Mona Khalil',
  primaryIdentity: {
    id: 'i1',
    kind: 'email',
    value: 'mona@example.com',
    verified: true,
    verifiedAt: null,
    source: 'agent',
  },
} as unknown as ContactSummary;

const openDialog = (contacts: readonly ContactSummary[] = [MONA]) => {
  const onSubmit = vi.fn<(value: NewTicketValue) => void>();
  const rendered = renderApp(
    <NewTicketDialog
      open
      departments={DEPARTMENTS}
      contacts={contacts}
      busy={false}
      onTermChange={() => {}}
      onSubmit={onSubmit}
      onClose={() => {}}
    />,
  );

  return { ...rendered, onSubmit };
};

const fillRequired = async (user: ReturnType<typeof openDialog>['user']): Promise<void> => {
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), 'A new ticket');
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'The first reply.');
};

describe('the new-ticket dialog', () => {
  it('starts on the brand’s first department rather than on nothing', () => {
    openDialog();

    expect(screen.getByRole('combobox', { name: 'Department' })).toHaveTextContent('Support');
  });

  it('refuses to file a ticket with no subject', async () => {
    const { user, onSubmit } = openDialog();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'The first reply.');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(screen.getByText('A subject is required')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses to file a ticket with no message, because the body is the thread', async () => {
    const { user, onSubmit } = openDialog();
    await user.type(screen.getByRole('textbox', { name: 'Subject' }), 'A new ticket');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(screen.getByText('A message is required')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('checks a new contact’s address with the normaliser the api uses', async () => {
    const { user, onSubmit } = openDialog();
    await user.click(screen.getByRole('button', { name: 'New contact' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Mona Khalil');
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'not-an-address');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(screen.getByText('That is not an email address')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks for a name as well as an address for a new contact', async () => {
    const { user, onSubmit } = openDialog();
    await user.click(screen.getByRole('button', { name: 'New contact' }));
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'mona@example.com');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(screen.getByText('A name is required')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('files the ticket against a contact that was picked', async () => {
    const { user, onSubmit } = openDialog();
    await user.click(screen.getByRole('button', { name: /Mona Khalil/ }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        contact: { kind: 'existing', contactId: MONA.id },
        subject: 'A new ticket',
        departmentId: DEPARTMENTS[0]?.id,
        priority: 'medium',
      }),
    );
  });

  it('files the ticket against a new contact when one was typed', async () => {
    const { user, onSubmit } = openDialog();
    await user.click(screen.getByRole('button', { name: 'New contact' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Jonas Weber');
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'jonas@acme.example');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        contact: { kind: 'new', name: 'Jonas Weber', email: 'jonas@acme.example' },
      }),
    );
  });

  it('files a ticket with nobody on it, which the api allows until M1-13', async () => {
    const { user, onSubmit } = openDialog();
    await user.click(screen.getByRole('button', { name: 'No contact' }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ contact: { kind: 'none' } }));
  });

  it('says why a ticket cannot be filed when the brand has no departments', () => {
    renderApp(
      <NewTicketDialog
        open
        departments={[]}
        contacts={[]}
        busy={false}
        onTermChange={() => {}}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText('This brand has no departments yet, so a ticket cannot be filed.'),
    ).toBeVisible();
  });
});
