import { screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpAuthApi } from '../auth/http-api.js';
import { MockAuthApi } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { AuthComplete } from './auth-complete.tsx';

afterEach(() => vi.unstubAllGlobals());

/** Shows what the code screen would be handed. */
function TotpProbe() {
  const state = useLocation().state as { factors?: { passkey: boolean } } | null;
  return <p>{`passkey:${String(state?.factors?.passkey)}`}</p>;
}

it('exchanges an SSO completion code once when React replays effects', async () => {
  const session = await new MockAuthApi().exchange('fixture');
  let spent = false;
  vi.stubGlobal('fetch', async () => {
    if (spent)
      return new Response(
        JSON.stringify({
          error: {
            code: 'unauthenticated',
            message: 'Already consumed',
            requestId: 'test',
            auth: { code: 'challenge-expired' },
          },
        }),
        { status: 401 },
      );
    spent = true;
    return new Response(
      JSON.stringify({ session, accessToken: 'fixture-token', expiresInSeconds: 600 }),
      { status: 201 },
    );
  });
  renderApp(
    <Routes>
      <Route path="/sign-in/complete" element={<AuthComplete />} />
      <Route path="/tickets" element={<h1>Desk opened</h1>} />
    </Routes>,
    {
      strictMode: true,
      authApi: new HttpAuthApi(),
      initialEntries: ['/sign-in/complete?code=one-use'],
    },
  );
  expect(await screen.findByRole('heading', { name: 'Desk opened' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('tells a person whose provider cannot make the first link to connect it from a session', async () => {
  renderApp(
    <Routes>
      <Route path="/oauth/callback" element={<AuthComplete />} />
    </Routes>,
    { initialEntries: ['/oauth/callback?error=oauth-link-required&provider=github'] },
  );

  expect(
    await screen.findByRole('heading', { level: 1, name: 'Connect your GitHub account first' }),
  ).toBeVisible();
  expect(screen.getAllByRole('listitem').map((step) => step.textContent)).toEqual([
    'Sign in with your password or a sign-in link.',
    'Open Your account › Security › Sign-in methods.',
    'Choose Connect GitHub.',
  ]);
  expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/sign-in');
});

it('says a Google account outside the allowed domains cannot sign in here', async () => {
  renderApp(
    <Routes>
      <Route path="/oauth/callback" element={<AuthComplete />} />
    </Routes>,
    { initialEntries: ['/oauth/callback?error=oauth-domain-not-allowed&provider=google'] },
  );

  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: "This Google account can't sign in here",
    }),
  ).toBeVisible();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('says a Microsoft account from another tenant cannot sign in here, without steps', async () => {
  renderApp(
    <Routes>
      <Route path="/oauth/callback" element={<AuthComplete />} />
    </Routes>,
    { initialEntries: ['/oauth/callback?error=oauth-tenant-mismatch&provider=microsoft'] },
  );

  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: "This Microsoft account can't sign in here",
    }),
  ).toBeVisible();
  expect(screen.getByText(/different organisation than the one this install trusts/)).toBeVisible();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/sign-in');
});

it('falls back to the sentence when the callback names no provider', async () => {
  renderApp(
    <Routes>
      <Route path="/oauth/callback" element={<AuthComplete />} />
    </Routes>,
    { initialEntries: ['/oauth/callback?error=oauth-link-required'] },
  );

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This account is not connected here yet. Sign in another way once, then connect it from your security page.',
  );
});

it('says what happened when this tab no longer knows which invitation it came from', async () => {
  renderApp(
    <Routes>
      <Route path="/oauth/callback" element={<AuthComplete />} />
    </Routes>,
    { initialEntries: ['/oauth/callback?error=oauth-invite-mismatch&provider=github'] },
  );

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'That GitHub account is not the invited address.',
  );
});

it('says an invitation spent by another tab is no longer valid', async () => {
  renderApp(
    <Routes>
      <Route path="/oauth/callback" element={<AuthComplete />} />
    </Routes>,
    { initialEntries: ['/oauth/callback?error=invite-expired&provider=google'] },
  );

  expect(await screen.findByRole('alert')).toHaveTextContent('This invitation is no longer valid.');
});

it.each([
  ['an app alone, when a link from before passkeys names none', '', false],
  ['a passkey as well as the app', '&factors=totp,passkey', true],
  ['a passkey alone', '&factors=passkey', true],
])('hands the second-factor screen the ways to answer: %s', async (_label, query, passkey) => {
  const api = new MockAuthApi();
  api.seedPasskeys({ count: 1 });
  renderApp(
    <Routes>
      <Route path="/sign-in/complete" element={<AuthComplete />} />
      <Route path="/sign-in/totp" element={<TotpProbe />} />
    </Routes>,
    {
      authApi: api,
      initialEntries: [`/sign-in/complete?challenge=c1&email=lina%40helpdock.com${query}`],
    },
  );

  expect(await screen.findByText(`passkey:${String(passkey)}`)).toBeInTheDocument();
});
