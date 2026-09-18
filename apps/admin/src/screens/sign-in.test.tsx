import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MOCK_EMAIL, MOCK_PASSWORD, MockAuthApi } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';

const renderSignIn = (path = '/sign-in') =>
  renderApp(<AppRoutes />, { authApi: new MockAuthApi(), initialEntries: [path] });

/** What the api renders into `index.html` when it serves the app. */
function describeInstall(domain: string, brandCount: number): void {
  document.head.insertAdjacentHTML(
    'beforeend',
    `<meta name="helpdock:primary-domain" content="${domain}" />` +
      `<meta name="helpdock:brand-count" content="${brandCount}" />`,
  );
}

afterEach(() => {
  for (const meta of document.head.querySelectorAll('meta[name^="helpdock:"]')) {
    meta.remove();
  }
});

describe('SignIn', () => {
  it('names the install and how many other brands it serves', async () => {
    describeInstall('support.helpdock.com', 3);
    renderSignIn();

    expect(
      await screen.findByText('Staff access for support.helpdock.com and 2 other brands.'),
    ).toBeInTheDocument();
  });

  it('drops the "and n others" clause on a single-brand install', async () => {
    describeInstall('support.helpdock.com', 1);
    renderSignIn();

    expect(await screen.findByText('Staff access for support.helpdock.com.')).toBeInTheDocument();
  });

  it('keeps the email and password fields left-to-right whatever the page direction', async () => {
    renderSignIn();

    expect(await screen.findByLabelText('Email')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('Password')).toHaveAttribute('dir', 'ltr');
  });

  it('refuses a malformed address before asking the api', async () => {
    const { user } = renderSignIn();

    await user.type(await screen.findByLabelText('Email'), 'lina@');
    await user.type(screen.getByLabelText('Password'), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('Enter an email address like name@example.com.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
      'Enter an email address like name@example.com.',
    );
  });

  it('announces a rejected password without saying which half was wrong', async () => {
    const { user } = renderSignIn();

    await user.type(await screen.findByLabelText('Email'), MOCK_EMAIL);
    await user.type(screen.getByLabelText('Password'), 'wrong horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password do not match.',
    );
  });

  it('goes on to the code screen when the password is right', async () => {
    const { user } = renderSignIn();

    await user.type(await screen.findByLabelText('Email'), MOCK_EMAIL);
    await user.type(screen.getByLabelText('Password'), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
  });

  it('sends a sign-in link and confirms where it went', async () => {
    const { user } = renderSignIn();

    await user.type(await screen.findByLabelText('Email'), MOCK_EMAIL);
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/lina@helpdock\.com/)).toBeInTheDocument();
  });

  it('switches the whole page to Arabic from the language link', async () => {
    const { user } = renderSignIn();

    await user.click(await screen.findByRole('button', { name: 'Switch to العربية' }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    });
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('heading', { name: 'تسجيل الدخول' })).toBeInTheDocument();
  });
});
