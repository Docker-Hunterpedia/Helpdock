import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { OPERATIONS_GUIDE_URL, SetupLayout } from './setup-layout.tsx';

const render = (step: 'account' | 'brand' | 'email' | 'done') =>
  renderApp(
    <SetupLayout step={step} systemStatus="v1.2.3 · api + worker healthy">
      <p>the step</p>
    </SetupLayout>,
  );

describe('SetupLayout', () => {
  it('names the four steps in order', () => {
    render('account');

    const items = within(screen.getByRole('navigation', { name: 'Setup progress' })).getAllByRole(
      'listitem',
    );

    expect(items.map((item) => item.textContent)).toEqual([
      '1 · Admin account',
      '2 · First brand',
      '3 · Outgoing email',
      '4 · Done',
    ]);
  });

  it('marks the current step, so it is not the bold weight alone that says so', () => {
    render('email');

    const current = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'step');

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('3 · Outgoing email');
  });

  it('says "done" in words beside the tick, which is decorative', () => {
    render('email');

    const [first, second, third] = screen.getAllByRole('listitem');

    // Colour and a tick alone would leave the state unreadable (DESIGN §10).
    expect(first).toHaveTextContent('1 · Admin account done');
    expect(second).toHaveTextContent('2 · First brand done');
    expect(third).not.toHaveTextContent('done');
  });

  it('counts the steps that are left', () => {
    render('brand');

    expect(screen.getByText('2 steps left')).toBeInTheDocument();
  });

  it('carries the version and health caption the wizard was given', () => {
    render('account');

    expect(screen.getByText('v1.2.3 · api + worker healthy')).toBeInTheDocument();
  });

  it('warns about the master key and links to the guide that says how to keep it', () => {
    render('account');

    expect(screen.getByText(/Keep your master key safe/)).toBeInTheDocument();
    expect(screen.getByText(/APP_MASTER_KEY/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How to back it up' })).toHaveAttribute(
      'href',
      OPERATIONS_GUIDE_URL,
    );
  });

  it('renders the step it was handed', () => {
    render('done');

    expect(screen.getByText('the step')).toBeInTheDocument();
  });
});
