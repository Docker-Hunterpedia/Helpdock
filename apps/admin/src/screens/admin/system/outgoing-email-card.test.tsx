import { screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import { fakeSystemApi, smtpSettingsFixture } from './fixtures.js';
import { OutgoingEmailCard } from './outgoing-email-card.js';
import { SystemApiError } from './system-api.js';

/**
 * The System page's Outgoing email card (#369), against the artboard
 * `Admin/System-OutgoingEmail`: the fields, the write-only password, the
 * pinned fields, and a test that draws the server's answer, in both languages.
 */

const PINNED = {
  host: true,
  port: false,
  tls: false,
  user: false,
  password: true,
  fromAddress: false,
  fromName: false,
};

it.each(['en', 'ar'] as const)(
  'draws the saved sender, its status and the test outcome in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const en = locale === 'en';
    const api = fakeSystemApi({
      testSmtpSettings: async () => ({
        delivered: true,
        response: '250 2.0.0 Ok: queued',
        recipient: 'lina@helpdock.com',
      }),
    });
    const { user } = renderApp(<OutgoingEmailCard api={api} />);

    const card = await screen.findByRole('region', {
      name: en ? 'Outgoing email settings' : 'إعدادات البريد الصادر',
    });
    expect(within(card).getByText(en ? 'Working' : 'يعمل')).toBeVisible();
    expect(within(card).getByDisplayValue('smtp.helpdock.dev')).toBeVisible();
    expect(within(card).getByDisplayValue('no-reply@helpdock.dev')).toBeVisible();

    // The stored password never reached the browser: an empty field and a placeholder.
    const password = within(card).getByLabelText(en ? 'Password' : 'كلمة المرور');
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute(
      'placeholder',
      en ? 'Saved · type to change' : 'محفوظة · اكتب لتغييرها',
    );
    expect(
      within(card).getByText(
        en
          ? 'Changing the server, port or username asks for the password again.'
          : 'تغيير الخادم أو المنفذ أو اسم المستخدم يتطلب كلمة المرور مجددًا.',
      ),
    ).toBeVisible();

    await user.click(
      within(card).getByRole('button', { name: en ? 'Send a test email' : 'إرسال رسالة تجريبية' }),
    );

    expect(
      await within(card).findByText(
        en
          ? 'Sent to lina@helpdock.com. The server said: 250 2.0.0 Ok: queued'
          : 'أُرسلت الرسالة إلى lina@helpdock.com. أجاب الخادم: 250 2.0.0 Ok: queued',
      ),
    ).toBeVisible();
  },
);

it('saves without resending the stored password, and draws what the api stored', async () => {
  const save = vi.fn(async (update: Record<string, unknown>) =>
    smtpSettingsFixture(update as never),
  );
  const { user } = renderApp(<OutgoingEmailCard api={fakeSystemApi({ saveSmtpSettings: save })} />);

  const port = await screen.findByLabelText('Port');
  await user.clear(port);
  await user.type(port, '465');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Outgoing email settings saved.')).toBeVisible();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ host: 'smtp.helpdock.dev', port: 465 }),
  );
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty('password');
});

it('warns while nothing is set up, and asks for the missing fields before saving', async () => {
  const save = vi.fn(async () => smtpSettingsFixture());
  const { user } = renderApp(
    <OutgoingEmailCard
      api={fakeSystemApi({
        saveSmtpSettings: save,
        smtpSettings: async () =>
          smtpSettingsFixture({
            configured: false,
            host: '',
            user: '',
            passwordConfigured: false,
            fromAddress: '',
            fromName: 'Helpdock',
          }),
      })}
    />,
  );

  expect(await screen.findByText('Not set')).toBeVisible();
  expect(
    screen.getByText(
      'Nothing is being sent. Until you set this up, nobody can reset a password or sign in by email.',
    ),
  ).toBeVisible();
  await user.type(await screen.findByLabelText('Server'), 'x');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Enter the address mail will come from.')).toBeVisible();
  expect(save).not.toHaveBeenCalled();
});

it('draws a failed test as the failure it names, with the port', async () => {
  const { user } = renderApp(
    <OutgoingEmailCard
      api={fakeSystemApi({
        testSmtpSettings: async () => ({ delivered: false, error: 'connection-refused' }),
      })}
    />,
  );

  await user.click(await screen.findByRole('button', { name: 'Send a test email' }));

  expect(
    await screen.findByText("Couldn't connect: the server refused the connection on port 587."),
  ).toBeVisible();
});

it('draws a rate-limited test as a wait in seconds, in both languages', async () => {
  for (const locale of ['en', 'ar'] as const) {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const en = locale === 'en';
    const { user, unmount } = renderApp(
      <OutgoingEmailCard
        api={fakeSystemApi({
          testSmtpSettings: async () => {
            throw new SystemApiError('the api answered 429', 429, { retryAfter: 40 });
          },
        })}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: en ? 'Send a test email' : 'إرسال رسالة تجريبية' }),
    );

    expect(
      await screen.findByText(
        en
          ? 'Too many tests. Wait 40 seconds and try again.'
          : 'محاولات كثيرة. انتظر 40 ثانية ثم أعد المحاولة.',
      ),
    ).toBeVisible();
    unmount();
  }
});

it('asks for the password again on the password field when the server changed', async () => {
  const refuse = async (): Promise<never> => {
    throw new SystemApiError('the api answered 400', 400, { reason: 'smtp-password-required' });
  };
  const { user } = renderApp(
    <OutgoingEmailCard
      api={fakeSystemApi({ saveSmtpSettings: refuse, testSmtpSettings: refuse })}
    />,
  );

  const host = await screen.findByLabelText('Server');
  await user.clear(host);
  await user.type(host, 'other.example.com');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(
    await screen.findByText('Type the password again to use it with this server.'),
  ).toBeVisible();
  expect(screen.getByLabelText('Password')).toBeInvalid();
  expect(screen.queryByText('The settings could not be saved. Try again.')).not.toBeInTheDocument();

  await user.type(screen.getByLabelText('Password'), 'x');
  expect(
    screen.queryByText('Type the password again to use it with this server.'),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Send a test email' }));
  expect(
    await screen.findByText('Type the password again to use it with this server.'),
  ).toBeVisible();
});

it('draws a pinned field read-only with a caption naming the variable, and names it on a 409', async () => {
  const { user } = renderApp(
    <OutgoingEmailCard
      api={fakeSystemApi({
        smtpSettings: async () =>
          smtpSettingsFixture({ host: 'pinned.example.com', locked: PINNED }),
        saveSmtpSettings: async () => {
          throw new SystemApiError('the api answered 409', 409, {
            detail: 'HD_SMTP_HOST locks this setting',
          });
        },
      })}
    />,
  );

  const host = await screen.findByLabelText('Server');
  expect(host).toHaveAttribute('readonly');
  expect(host).toHaveValue('pinned.example.com');
  expect(await screen.findByText('Set by HD_SMTP_HOST in the environment.')).toBeVisible();
  expect(screen.getByText('Set by HD_SMTP_PASSWORD in the environment.')).toBeVisible();

  const from = await screen.findByLabelText('From address');
  await user.clear(from);
  await user.type(from, 'other@example.com');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(
    await screen.findByText(
      "HD_SMTP_HOST sets this in the environment, so it can't be changed here. Remove it from .env to edit it here.",
    ),
  ).toBeVisible();
});

it('falls back to the generic message when a save fails for another reason', async () => {
  const { user } = renderApp(
    <OutgoingEmailCard
      api={fakeSystemApi({
        saveSmtpSettings: async () => {
          throw new SystemApiError('the api answered 500', 500);
        },
      })}
    />,
  );

  const from = await screen.findByLabelText('From address');
  await user.type(from, 'x');
  await user.clear(from);
  await user.type(from, 'other@example.com');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('The settings could not be saved. Try again.')).toBeVisible();
});
