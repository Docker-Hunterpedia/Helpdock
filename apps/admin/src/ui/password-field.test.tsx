import { screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render.tsx';
import { PasswordField, type PasswordRefusal } from './password-field.tsx';

function Harness({ refusal = null }: { readonly refusal?: PasswordRefusal | null }): ReactNode {
  const [value, setValue] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <PasswordField
        id="new-password"
        label="New password"
        value={value}
        onChange={setValue}
        hint="At least 12 characters."
        refusal={refusal}
      />
      <button type="submit">Save</button>
    </form>
  );
}

describe('PasswordField', () => {
  it('hides the password until asked, and says which way the toggle points', async () => {
    const { user } = renderApp(<Harness />);
    const input = screen.getByLabelText('New password');
    await user.type(input, 'correct horse ledger');

    expect(input).toHaveAttribute('type', 'password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);

    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('hides it again when the form is sent', async () => {
    const { user } = renderApp(<Harness />);
    const input = screen.getByLabelText('New password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(input).toHaveAttribute('type', 'password');
  });

  it('reads the hint until the api refuses, and nothing is invalid before that', () => {
    renderApp(<Harness />);
    const input = screen.getByLabelText('New password');

    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).toHaveAccessibleDescription('At least 12 characters.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('turns the hint into the error when the password is too short', () => {
    renderApp(
      <Harness refusal={{ kind: 'short', message: 'Use at least 12 characters. 7 so far.' }} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 12 characters. 7 so far.');
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says a breached password was checked on this server, and nowhere else', () => {
    renderApp(<Harness refusal={{ kind: 'breached' }} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This password appears in lists of leaked passwords, so attackers try it first. Choose another one.',
    );
    expect(
      screen.getByText(
        'Checked on this server against a bundled list. The password is never sent anywhere else.',
      ),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-strength]')).toHaveAttribute('data-strength', 'refused');
  });
});
