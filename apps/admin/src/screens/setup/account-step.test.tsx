import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { AccountStep, validateAccount } from './account-step.tsx';

const draft = {
  name: 'Lina',
  email: 'lina@example.com',
  password: 'a very long passphrase',
};

const render = () => {
  const onSubmit = vi.fn();

  return {
    onSubmit,
    ...renderApp(
      <AccountStep locale="en" onLocaleChange={vi.fn()} onSubmit={onSubmit} pending={false} />,
    ),
  };
};

describe('validateAccount', () => {
  it('accepts a complete draft', () => {
    expect(validateAccount(draft)).toEqual({});
  });

  it.each([
    [{ name: '   ' }, { name: 'required' }],
    [{ email: '' }, { email: 'required' }],
    [{ email: 'lina@' }, { email: 'invalid' }],
    [{ password: '' }, { password: 'required' }],
    [{ password: 'elevenchar' }, { password: 'short' }],
    [{ password: 'password1234' }, { password: 'weak' }],
  ])('refuses %j', (override, expected) => {
    expect(validateAccount({ ...draft, ...override })).toEqual(expected);
  });

  it('refuses the weak password the api would refuse, and no other', () => {
    // The meter and the server share `estimatePasswordStrength`, so a password
    // that passes here can never be rejected on submit.
    expect(validateAccount({ ...draft, password: 'twelveletter' })).toEqual({});
  });
});

describe('AccountStep', () => {
  it('says nothing about strength before anything is typed', () => {
    render();

    expect(screen.getByText('Password strength: Too easy to guess')).toBeInTheDocument();
  });

  it('names the strength in words, so nothing depends on the meter’s colour', async () => {
    const { user } = render();

    await user.type(screen.getByLabelText('Password'), 'a very long passphrase');

    expect(screen.getByText('Password strength: Strong')).toBeInTheDocument();
  });

  it('shows one message per rejected field rather than submitting', async () => {
    const { user, onSubmit } = render();

    await user.click(screen.getByRole('button', { name: 'Create account and continue' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Enter the name colleagues will see.')).toBeInTheDocument();
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
    expect(screen.getByText('Choose a password.')).toBeInTheDocument();
  });

  it('trims what it sends, because a stray space is not part of a name', async () => {
    const { user, onSubmit } = render();

    await user.type(screen.getByLabelText('Your name'), '  Lina  ');
    await user.type(screen.getByLabelText('Email'), ' lina@example.com ');
    await user.type(screen.getByLabelText('Password'), 'a very long passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account and continue' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Lina',
      email: 'lina@example.com',
      password: 'a very long passphrase',
      locale: 'en',
    });
  });
});
