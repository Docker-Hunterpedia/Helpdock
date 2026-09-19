import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { EmailStep, validateEmail } from './email-step.tsx';

const draft = {
  host: 'smtp.example.com',
  port: '587',
  fromAddress: 'support@example.com',
  fromName: 'Acme Support',
};

const render = (overrides: Partial<Parameters<typeof EmailStep>[0]> = {}) => {
  const onSubmit = vi.fn();
  const onTest = vi.fn();
  const onBack = vi.fn();

  return {
    onSubmit,
    onTest,
    onBack,
    ...renderApp(
      <EmailStep
        onSubmit={onSubmit}
        onTest={onTest}
        onBack={onBack}
        pending={false}
        testPending={false}
        testResult={null}
        adminEmail="lina@example.com"
        {...overrides}
      />,
    ),
  };
};

const fill = async (user: ReturnType<typeof renderApp>['user']): Promise<void> => {
  await user.type(screen.getByLabelText('SMTP server'), draft.host);
  await user.type(screen.getByLabelText('From address'), draft.fromAddress);
  await user.type(screen.getByLabelText('From name'), draft.fromName);
};

describe('validateEmail', () => {
  it('accepts a complete draft', () => {
    expect(validateEmail(draft)).toEqual({});
  });

  it.each([
    [{ host: ' ' }, { host: 'required' }],
    [{ port: '0' }, { port: 'invalid' }],
    [{ port: '70000' }, { port: 'invalid' }],
    [{ port: 'smtp' }, { port: 'invalid' }],
    [{ fromAddress: '' }, { fromAddress: 'required' }],
    [{ fromAddress: 'support@' }, { fromAddress: 'invalid' }],
    [{ fromName: '  ' }, { fromName: 'required' }],
  ])('refuses %j', (override, expected) => {
    expect(validateEmail({ ...draft, ...override })).toEqual(expected);
  });
});

describe('EmailStep', () => {
  it('moves the port with the encryption mode, which is the choice they make together', async () => {
    const { user } = render();

    expect(screen.getByLabelText('Port')).toHaveValue(587);

    await user.selectOptions(screen.getByLabelText('Encryption'), 'tls');
    expect(screen.getByLabelText('Port')).toHaveValue(465);

    await user.selectOptions(screen.getByLabelText('Encryption'), 'none');
    expect(screen.getByLabelText('Port')).toHaveValue(25);
  });

  it('checks the fields before opening a socket to whatever was typed', async () => {
    const { user, onTest } = render();

    await user.click(screen.getByRole('button', { name: 'Send a test email' }));

    expect(onTest).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the SMTP server's hostname.")).toBeInTheDocument();
  });

  it('tests with exactly what is on screen, so nothing has to be saved first', async () => {
    const { user, onTest } = render();

    await fill(user);
    await user.type(screen.getByLabelText('Username'), 'postmaster');
    await user.type(screen.getByLabelText('Password'), 'relay-secret');
    await user.click(screen.getByRole('button', { name: 'Send a test email' }));

    expect(onTest).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
      user: 'postmaster',
      password: 'relay-secret',
      fromAddress: 'support@example.com',
      fromName: 'Acme Support',
    });
  });

  it('saves the same values, marked as not a skip', async () => {
    const { user, onSubmit } = render();

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ skip: false }));
  });

  it('skips without filling anything in, and says so in the request', async () => {
    const { user, onSubmit } = render();

    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(onSubmit).toHaveBeenCalledWith({ skip: true });
  });

  it('draws the relay’s reply when there is one', () => {
    render({ testResult: { delivered: true, response: '250 2.0.0 Ok' } });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Delivered to lina@example.com. The server answered: 250 2.0.0 Ok',
    );
  });

  it('draws a plain confirmation when the relay said nothing quotable', () => {
    render({ testResult: { delivered: true } });

    expect(screen.getByRole('alert')).toHaveTextContent('Delivered to lina@example.com.');
  });

  it.each([
    ['auth-failed', 'The server refused those credentials. Check the username and password.'],
    ['connection-refused', 'Could not reach that server. Check the hostname and the port.'],
    ['tls-error', 'The encrypted connection failed. Try a different encryption setting.'],
    ['timeout', 'The server did not answer within ten seconds.'],
    ['rejected', 'The server refused the message. Check the From address.'],
    ['unknown', 'The test could not be completed. Check the details and try again.'],
  ] as const)('has a sentence for %s', (error, message) => {
    render({ testResult: { delivered: false, error } });

    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('falls back to the catch-all sentence for a failure with no code at all', () => {
    render({ testResult: { delivered: false } });

    expect(screen.getByRole('alert')).toHaveTextContent('The test could not be completed.');
  });

  it('will not let the step be skipped while a test is in flight', () => {
    render({ testPending: true });

    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeDisabled();
  });
});
