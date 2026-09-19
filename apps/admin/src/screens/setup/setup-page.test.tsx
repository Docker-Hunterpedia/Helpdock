import type {
  SetupAdminRequest,
  SetupBrandRequest,
  SetupCompleteResponse,
  SetupSmtpRequest,
  SmtpCredentials,
  SmtpTestResult,
} from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIGNED_IN_ROUTE, ROUTES } from '../../app/route-paths.js';
import { renderApp } from '../../test/render.tsx';
import type { SetupApi } from './setup-api.js';
import { SetupClosedError, SetupThrottledError, SetupValidationError } from './setup-api.js';
import { SetupPage } from './setup-page.tsx';

/**
 * The wizard as a whole: four steps, the decisions each one records, and what
 * the screen does with each of the api's three refusals. The steps' own field
 * rules are unit tested beside them; what is proved here is that finishing one
 * step reaches the next with the right request.
 */

const PASSWORD = 'a very long passphrase';

class FakeSetupApi implements SetupApi {
  readonly adminRequests: SetupAdminRequest[] = [];
  readonly brandRequests: SetupBrandRequest[] = [];
  readonly smtpRequests: SetupSmtpRequest[] = [];
  readonly testRequests: SmtpCredentials[] = [];
  completions = 0;

  brandError: unknown = null;
  testResult: SmtpTestResult = { delivered: true, response: '250 2.0.0 Ok' };
  smtpError: unknown = null;
  require2fa = false;

  createAdmin(request: SetupAdminRequest) {
    this.adminRequests.push(request);

    return Promise.resolve({
      setupToken: 'token',
      expiresInSeconds: 1800,
      admin: {
        id: '0199f4b2-6a91-7c27-9a1f-000000000001',
        name: request.name,
        email: request.email,
      },
    });
  }

  createBrand(request: SetupBrandRequest) {
    if (this.brandError !== null) {
      return Promise.reject(this.brandError);
    }
    this.brandRequests.push(request);

    return Promise.resolve({
      brand: {
        id: '0199f4b2-6a91-7c27-9a1f-00000000000a',
        name: request.name,
        prefix: request.prefix,
        defaultLocale: request.defaultLocale,
        timezone: request.timezone,
      },
      helpcenterDomain: request.helpcenterDomain ?? null,
      departmentCreated: false,
    });
  }

  testSmtp(request: SmtpCredentials): Promise<SmtpTestResult> {
    this.testRequests.push(request);

    return Promise.resolve(this.testResult);
  }

  saveSmtp(request: SetupSmtpRequest) {
    if (this.smtpError !== null) {
      return Promise.reject(this.smtpError);
    }
    this.smtpRequests.push(request);

    return Promise.resolve({ configured: !request.skip });
  }

  complete(): Promise<SetupCompleteResponse> {
    this.completions += 1;

    return Promise.resolve({ require2fa: this.require2fa });
  }
}

const renderWizard = (api: SetupApi, onFinished = vi.fn()) => ({
  ...renderApp(<SetupPage api={api} onFinished={onFinished} />),
  onFinished,
});

const fillAccount = async (user: ReturnType<typeof renderApp>['user']): Promise<void> => {
  await user.type(screen.getByLabelText('Your name'), 'Lina');
  await user.type(screen.getByLabelText('Email'), 'lina@example.com');
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Create account and continue' }));
};

const fillBrand = async (
  user: ReturnType<typeof renderApp>['user'],
  prefix = 'ACME',
): Promise<void> => {
  await user.type(screen.getByLabelText('Brand name'), 'Acme');
  await user.type(screen.getByLabelText('Ticket prefix'), prefix);
  await user.click(screen.getByRole('button', { name: 'Create brand and continue' }));
};

beforeEach(() => {
  // The caption reads `/ready`; nothing under test depends on the answer.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'ready', checks: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the first-run wizard', () => {
  it('walks the four steps and reports what each one decided', async () => {
    const api = new FakeSetupApi();
    const { user, onFinished } = renderWizard(api);

    await fillAccount(user);
    expect(api.adminRequests[0]).toEqual({
      name: 'Lina',
      email: 'lina@example.com',
      password: PASSWORD,
      locale: 'en',
    });

    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);
    expect(api.brandRequests[0]).toMatchObject({ name: 'Acme', prefix: 'ACME' });

    await screen.findByRole('heading', { name: 'Outgoing email' });
    await user.type(screen.getByLabelText('SMTP server'), 'smtp.example.com');
    await user.type(screen.getByLabelText('From address'), 'support@example.com');
    await user.type(screen.getByLabelText('From name'), 'Acme Support');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(api.smtpRequests[0]).toMatchObject({
      skip: false,
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
    });

    await screen.findByRole('heading', { name: 'Helpdock is ready' });
    // The token is spent on arrival, not on the button: the summary has to know
    // whether a second factor is required before it is drawn.
    await waitFor(() => {
      expect(api.completions).toBe(1);
    });
    expect(screen.getByText('lina@example.com')).toBeInTheDocument();
    expect(screen.getByText('Acme · ACME')).toBeInTheDocument();
    expect(screen.getByText('smtp.example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Helpdock' }));
    expect(onFinished).toHaveBeenCalledWith(DEFAULT_SIGNED_IN_ROUTE);
  });

  it('records a skipped email step and says so in the summary', async () => {
    const api = new FakeSetupApi();
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);

    await screen.findByRole('heading', { name: 'Outgoing email' });
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    await screen.findByRole('heading', { name: 'Helpdock is ready' });
    expect(api.smtpRequests[0]).toEqual({ skip: true });
    expect(screen.getByText('Not configured yet')).toBeInTheDocument();
  });

  it('sends the enrolment screen next when the install requires a second factor', async () => {
    const api = new FakeSetupApi();
    api.require2fa = true;
    const { user, onFinished } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);
    await screen.findByRole('heading', { name: 'Outgoing email' });
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    await screen.findByText(/two-factor authentication/);
    await user.click(screen.getByRole('button', { name: 'Open Helpdock' }));

    expect(onFinished).toHaveBeenCalledWith(ROUTES.totpEnrolment);
  });

  it('goes back to the brand step without losing the account it created', async () => {
    const api = new FakeSetupApi();
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);

    await screen.findByRole('heading', { name: 'Outgoing email' });
    await user.click(screen.getByRole('button', { name: 'Back' }));

    await screen.findByRole('heading', { name: 'Your first brand' });
    expect(api.adminRequests).toHaveLength(1);
  });

  it('draws the relay’s reply after a test that was delivered', async () => {
    const api = new FakeSetupApi();
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);
    await screen.findByRole('heading', { name: 'Outgoing email' });

    await user.type(screen.getByLabelText('SMTP server'), 'smtp.example.com');
    await user.type(screen.getByLabelText('From address'), 'support@example.com');
    await user.type(screen.getByLabelText('From name'), 'Acme Support');
    await user.click(screen.getByRole('button', { name: 'Send a test email' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Delivered to lina@example.com. The server answered: 250 2.0.0 Ok',
    );
    expect(api.testRequests[0]).toMatchObject({ host: 'smtp.example.com', port: 587 });
  });

  it('draws one sentence per SMTP failure, and never the server’s own words', async () => {
    const api = new FakeSetupApi();
    api.testResult = { delivered: false, error: 'auth-failed' };
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);
    await screen.findByRole('heading', { name: 'Outgoing email' });

    await user.type(screen.getByLabelText('SMTP server'), 'smtp.example.com');
    await user.type(screen.getByLabelText('From address'), 'support@example.com');
    await user.type(screen.getByLabelText('From name'), 'Acme Support');
    await user.click(screen.getByRole('button', { name: 'Send a test email' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server refused those credentials. Check the username and password.',
    );
  });

  it('marks the prefix as taken when only the api could have known', async () => {
    const api = new FakeSetupApi();
    api.brandError = new SetupValidationError(['prefix']);
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);

    expect(
      await screen.findByText('That prefix is already in use on this install.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your first brand' })).toBeInTheDocument();
  });

  it('says the wizard is closed and offers the sign-in screen instead', async () => {
    const api = new FakeSetupApi();
    api.brandError = new SetupClosedError();
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('This install has already been set up.');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      ROUTES.signIn,
    );
  });

  it('says to wait when the address has spent its budget', async () => {
    const api = new FakeSetupApi();
    api.brandError = new SetupThrottledError();
    const { user } = renderWizard(api);

    await fillAccount(user);
    await screen.findByRole('heading', { name: 'Your first brand' });
    await fillBrand(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts from this address.',
    );
  });

  it('switches the whole document to Arabic the moment the language is chosen', async () => {
    const api = new FakeSetupApi();
    const { user } = renderWizard(api);

    await user.selectOptions(screen.getByLabelText('Your language'), 'ar');

    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ar');
    });
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { name: 'إعداد Helpdock', level: 1 })).toBeInTheDocument();
  });

  it('sends the chosen locale as the new account’s own', async () => {
    const api = new FakeSetupApi();
    const { user } = renderWizard(api);

    await user.selectOptions(screen.getByLabelText('Your language'), 'ar');
    await user.type(screen.getByLabelText('اسمك'), 'لينا');
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'lina@example.com');
    await user.type(screen.getByLabelText('كلمة المرور'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'إنشاء الحساب والمتابعة' }));

    await waitFor(() => {
      expect(api.adminRequests[0]?.locale).toBe('ar');
    });
  });
});
