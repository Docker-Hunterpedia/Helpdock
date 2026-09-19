import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { BrandStep, validateBrand } from './brand-step.tsx';

const draft = {
  name: 'Acme',
  prefix: 'ACME',
  timezone: 'Europe/Berlin',
  helpcenterDomain: '',
};

const render = ({ prefixTaken = false } = {}) => {
  const onSubmit = vi.fn();
  const onBack = vi.fn();

  return {
    onSubmit,
    onBack,
    ...renderApp(
      <BrandStep onSubmit={onSubmit} onBack={onBack} pending={false} prefixTaken={prefixTaken} />,
    ),
  };
};

describe('validateBrand', () => {
  it('accepts a brand with no help center domain', () => {
    expect(validateBrand(draft)).toEqual({});
  });

  it('accepts one with a domain', () => {
    expect(validateBrand({ ...draft, helpcenterDomain: 'Support.Acme.TEST' })).toEqual({});
  });

  it.each([
    [{ name: ' ' }, { name: 'required' }],
    [{ prefix: '' }, { prefix: 'required' }],
    [{ prefix: 'A' }, { prefix: 'invalid' }],
    [{ prefix: 'AC-ME' }, { prefix: 'invalid' }],
    [{ timezone: 'Mars/Olympus' }, { timezone: 'invalid' }],
    [{ helpcenterDomain: 'not a host' }, { helpcenterDomain: 'invalid' }],
  ])('refuses %j', (override, expected) => {
    expect(validateBrand({ ...draft, ...override })).toEqual(expected);
  });
});

describe('BrandStep', () => {
  it('previews the ticket number as the prefix is typed', async () => {
    const { user } = render();

    expect(screen.getByText(/HD-1042/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Ticket prefix'), 'acme');

    expect(screen.getByText(/ACME-1042/)).toBeInTheDocument();
  });

  it('upper-cases the prefix as it is typed and stops at six characters', async () => {
    const { user } = render();
    const field = screen.getByLabelText('Ticket prefix');

    await user.type(field, 'acme2468');

    expect(field).toHaveValue('ACME24');
  });

  it('sends the domain lower-cased, or omits it entirely', async () => {
    const { user, onSubmit } = render();

    await user.type(screen.getByLabelText('Brand name'), 'Acme');
    await user.type(screen.getByLabelText('Ticket prefix'), 'ACME');
    await user.click(screen.getByRole('button', { name: 'Create brand and continue' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ helpcenterDomain: expect.anything() }),
    );

    await user.type(screen.getByLabelText('Help center domain'), 'Support.Acme.TEST');
    await user.click(screen.getByRole('button', { name: 'Create brand and continue' }));

    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ helpcenterDomain: 'support.acme.test' }),
    );
  });

  it('shows the api’s verdict on a prefix the screen could not have judged', () => {
    render({ prefixTaken: true });

    expect(screen.getByText('That prefix is already in use on this install.')).toBeInTheDocument();
  });

  it('offers a way back without submitting anything', async () => {
    const { user, onBack, onSubmit } = render();

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
