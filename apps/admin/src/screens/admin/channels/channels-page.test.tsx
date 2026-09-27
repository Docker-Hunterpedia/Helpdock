import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import type { EmailApi } from '../../../email/api.js';
import { MockEmailApi } from '../../../email/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { capOf } from './auto-replies-card.tsx';
import { sendersRequestOf } from './senders-card.tsx';
import { smtpRequestOf } from './smtp-card.tsx';
import { fillSample } from './template-dialog.tsx';

/**
 * `Admin/Channels · Outgoing email` against the fixture (M2-05, M2-06, M2-08):
 * the SMTP section and its test, the senders table, the auto-replies and their
 * template editor, and Failed sends.
 */

const renderOutgoing = async (
  emailApi: EmailApi = new MockEmailApi(),
  path = '/admin/channels/outgoing',
) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    emailApi,
    initialEntries: [path],
  });

  await screen.findByRole('heading', { name: 'Outgoing mail (SMTP)' });
  return { ...rendered, emailApi };
};

const section = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('Channels', () => {
  it('opens the Outgoing email tab by its url, beside Mailboxes, without "Add mailbox"', async () => {
    await renderOutgoing();

    expect(screen.getByRole('tab', { name: 'Outgoing email' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Mailboxes' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add mailbox' })).toBeNull();
  });
});

describe('Outgoing mail (SMTP)', () => {
  it('shows the stored server, keeps the password hidden, and saves a replacement', async () => {
    const { user, emailApi } = await renderOutgoing();
    const smtp = section('Outgoing mail (SMTP)');

    expect(within(smtp).getByLabelText('SMTP host')).toHaveValue('smtp.fastmail.com');
    expect(within(smtp).getByLabelText('Password')).toHaveAttribute('readonly');
    expect(within(smtp).getByText(/by Lina Haddad/)).toBeVisible();

    await user.click(within(smtp).getByRole('button', { name: 'Replace' }));
    await user.type(within(smtp).getByLabelText('Password'), 'new-app-password');
    await user.click(within(smtp).getByRole('button', { name: 'Save outgoing mail' }));

    expect(await screen.findByText('Outgoing mail saved.')).toBeVisible();
    expect((await emailApi.outgoing('b')).smtp?.passwordSet).toBe(true);
  });

  it('refuses to save without a host, and puts the form back on Discard', async () => {
    const { user } = await renderOutgoing();
    const smtp = section('Outgoing mail (SMTP)');
    const host = within(smtp).getByLabelText('SMTP host');

    await user.clear(host);
    await user.click(within(smtp).getByRole('button', { name: 'Save outgoing mail' }));
    expect(within(smtp).getByText('Enter the SMTP host.')).toBeVisible();

    await user.click(within(smtp).getByRole('button', { name: 'Discard' }));
    expect(host).toHaveValue('smtp.fastmail.com');
  });

  it('reports an accepted test and a refused one in the relay’s own words', async () => {
    const { user } = await renderOutgoing();
    const smtp = section('Outgoing mail (SMTP)');

    await user.click(within(smtp).getByRole('button', { name: 'Test SMTP' }));
    expect(await within(smtp).findByText('Test message accepted')).toBeVisible();

    const host = within(smtp).getByLabelText('SMTP host');
    await user.clear(host);
    await user.type(host, 'fail.example.com');
    await user.click(within(smtp).getByRole('button', { name: 'Test SMTP' }));

    const alert = await within(smtp).findByRole('alert');
    expect(alert).toHaveTextContent('The SMTP server refused the sign-in');
    expect(alert).toHaveTextContent('535 5.7.8 Authentication credentials invalid');
  });

  it("says a brand with no server of its own sends through the install's", async () => {
    class WithoutServer extends MockEmailApi {
      override async outgoing(brandId: string) {
        return { ...(await super.outgoing(brandId)), smtp: null };
      }
    }

    await renderOutgoing(new WithoutServer());

    expect(screen.getByText(/sends through the install's/)).toBeVisible();
  });
});

describe('From and Reply-To per department', () => {
  it('adds a department, refuses a From that is not a sender, and saves once it is', async () => {
    const { user, emailApi } = await renderOutgoing();
    const senders = section('From and Reply-To per department');

    await user.click(within(senders).getByRole('combobox', { name: 'Department to add' }));
    await user.click(await screen.findByRole('option', { name: 'Support' }));
    await user.click(within(senders).getByRole('button', { name: 'Add department' }));

    const from = within(senders).getByRole('textbox', { name: 'From for Support' });
    await user.type(from, 'Support');
    await user.click(within(senders).getByRole('button', { name: 'Save senders' }));
    expect(within(senders).getByText(/Write it as Name/)).toBeVisible();

    await user.clear(from);
    await user.type(from, 'Helpdock Support <help@helpdock.io>');
    await user.click(within(senders).getByRole('button', { name: 'Save senders' }));

    expect(await screen.findByText('Senders saved.')).toBeVisible();
    expect(
      (await emailApi.outgoing('b')).senders.departments.map((row) => row.from.address),
    ).toEqual(['billing@helpdock.io', 'help@helpdock.io']);
  });

  it('removes a row', async () => {
    const { user, emailApi } = await renderOutgoing();
    const senders = section('From and Reply-To per department');

    await user.click(within(senders).getByRole('button', { name: 'Remove the Billing row' }));
    await user.click(within(senders).getByRole('button', { name: 'Save senders' }));

    expect(await screen.findByText('Senders saved.')).toBeVisible();
    expect((await emailApi.outgoing('b')).senders.departments).toEqual([]);
  });
});

describe('Auto-replies', () => {
  it('turns the out-of-hours reply on and changes the cap in one save', async () => {
    const { user, emailApi } = await renderOutgoing();
    const auto = section('Auto-replies');

    await user.click(within(auto).getByRole('switch', { name: 'Out-of-hours reply' }));
    const cap = within(auto).getByRole('spinbutton', {
      name: 'Auto-replies to one sender per hour',
    });
    await user.clear(cap);
    await user.type(cap, '5');
    await user.click(within(auto).getByRole('button', { name: 'Save auto-replies' }));

    expect(await screen.findByText('Auto-replies saved.')).toBeVisible();
    expect((await emailApi.outgoing('b')).autoReplies).toMatchObject({
      outOfHours: { enabled: true },
      perSenderHourlyCap: 5,
    });
  });

  it('refuses a cap outside 1 to 50', async () => {
    const { user } = await renderOutgoing();
    const auto = section('Auto-replies');
    const cap = within(auto).getByRole('spinbutton', {
      name: 'Auto-replies to one sender per hour',
    });

    await user.clear(cap);
    await user.type(cap, '0');
    await user.click(within(auto).getByRole('button', { name: 'Save auto-replies' }));

    expect(within(auto).getByRole('alert')).toHaveTextContent('Enter a number from 1 to 50.');
  });

  it('edits a template in its dialog, previews it with a sample, and saves it', async () => {
    const { user, emailApi } = await renderOutgoing();

    await user.click(
      screen.getByRole('button', { name: 'Edit the Acknowledgment template in English' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Acknowledgment · English' });
    const subject = within(dialog).getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Got it: {{{{ticket.number}}');
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(within(dialog).getByText('Got it: HD-1042')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Save template' }));

    expect(await screen.findByText('Template saved.')).toBeVisible();
    expect((await emailApi.outgoing('b')).autoReplies.acknowledgment.templates.en.subject).toBe(
      'Got it: {{ticket.number}}',
    );
  });

  it('refuses an empty template and closes on Cancel without saving', async () => {
    const { user } = await renderOutgoing();

    await user.click(
      screen.getByRole('button', { name: 'Edit the Out-of-hours reply template in Arabic' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Body'));
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }));
    expect(within(dialog).getByText('Enter a subject and a body.')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Failed sends', () => {
  it('lists each dead-lettered send with its error and attempts', async () => {
    await renderOutgoing();
    const failed = section('Failed sends');

    const rows = await within(failed).findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(failed).getByText(/mailbox full/)).toBeVisible();
    expect(within(failed).getAllByText('5 / 5')).toHaveLength(2);
    expect(within(failed).getByRole('link', { name: 'HD-1042' })).toHaveAttribute(
      'href',
      '/tickets/0192c3f0-1a2b-7c3d-8e4f-000000001042',
    );
  });

  it('retries one, discards one, and says when nothing is left', async () => {
    const { user } = await renderOutgoing();
    const failed = section('Failed sends');

    await user.click(
      await within(failed).findByRole('button', {
        name: 'Retry the send to mona@example.com on HD-1042',
      }),
    );
    expect(await screen.findByText('Sent back to the queue.')).toBeVisible();

    await user.click(
      await within(failed).findByRole('button', {
        name: 'Discard the send to k.nasser@acme.de on HD-1035',
      }),
    );
    expect(await within(failed).findByText(/No failed sends/)).toBeVisible();
  });

  it('retries everything at once', async () => {
    const { user } = await renderOutgoing();
    const failed = section('Failed sends');

    await user.click(await within(failed).findByRole('button', { name: 'Retry all' }));

    expect(await screen.findByText('Every failed send went back to the queue.')).toBeVisible();
    expect(await within(failed).findByText(/No failed sends/)).toBeVisible();
  });

  it('says so when an action fails', async () => {
    class Failing extends MockEmailApi {
      override retryAllFailedSends(): Promise<number> {
        return Promise.reject(new Error('down'));
      }
    }
    const { user } = await renderOutgoing(new Failing());

    await user.click(
      await within(section('Failed sends')).findByRole('button', { name: 'Retry all' }),
    );

    expect(await screen.findByText('That did not work. Nothing was changed.')).toBeVisible();
  });
});

describe('the form rules', () => {
  it('reads an SMTP draft into a request, keeping the stored password unless replaced', () => {
    const draft = {
      host: ' smtp.example.com ',
      port: '587',
      tls: 'starttls' as const,
      user: '',
      password: null,
    };

    expect(smtpRequestOf(draft)).toEqual({
      ok: true,
      request: { host: 'smtp.example.com', port: 587, tls: 'starttls', user: '' },
    });
    expect(smtpRequestOf({ ...draft, password: 'x' })).toMatchObject({
      request: { password: 'x' },
    });
    expect(smtpRequestOf({ ...draft, port: '70000' })).toEqual({ ok: false, problem: 'port' });
  });

  it('names every sender field that is wrong', () => {
    const outcome = sendersRequestOf({
      defaultFrom: 'nobody',
      rows: [
        { departmentId: 'd1', from: 'Billing <billing@example.com>', replyTo: 'not-an-address' },
      ],
    });

    expect(outcome).toEqual({ ok: false, problems: new Set(['default', 'replyTo:d1']) });
  });

  it('accepts a cap from 1 to 50', () => {
    expect(capOf('1')).toBe(1);
    expect(capOf('50')).toBe(50);
    expect(capOf('2.5')).toBeNull();
  });

  it('fills a template with the sample in its own language', () => {
    expect(fillSample('{{contact.first_name}} · {{ticket.number}}', 'ar')).toBe('سارة · HD-1039');
  });
});
