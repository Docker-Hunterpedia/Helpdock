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
  ])('refuses %j', (override, expected) => {
    expect(validateAccount({ ...draft, ...override })).toEqual(expected);
  });

  it('applies the length floor and no composition rule, as the api does', () => {
    // A rule the form enforced and the server did not would be a rule nobody
    // could explain; the bar under the field is a hint (M0-06).
    expect(validateAccount({ ...draft, password: 'password1234' })).toEqual({});
  });
});

describe('AccountStep', () => {
  it('names the reading in words, so nothing depends on the bar’s colour', async () => {
    const { user } = render();

    // The bar is `aria-hidden`; the hint is what `aria-describedby` points at.
    expect(screen.getByText('At least 12 characters. Weak.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'a very long passphrase');

    expect(screen.getByText('At least 12 characters. Strong.')).toBeInTheDocument();
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
