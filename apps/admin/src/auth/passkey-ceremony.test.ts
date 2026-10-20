import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  class WebAuthnError extends Error {
    code: string;
    constructor(code: string, cause?: Error) {
      super(code, cause === undefined ? undefined : { cause });
      this.code = code;
    }
  }
  return {
    WebAuthnError,
    supported: true,
    autofill: true,
    cancelCeremony: vi.fn(),
    startRegistration: vi.fn(),
    startAuthentication: vi.fn(),
  };
});

vi.mock('@simplewebauthn/browser', () => ({
  WebAuthnError: browser.WebAuthnError,
  browserSupportsWebAuthn: () => browser.supported,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(browser.autofill),
  WebAuthnAbortService: { cancelCeremony: browser.cancelCeremony },
  startRegistration: browser.startRegistration,
  startAuthentication: browser.startAuthentication,
}));

const {
  assertPasskey,
  cancelPasskeyCeremony,
  createPasskey,
  isPasskeyCeremonyError,
  passkeyAutofillSupported,
} = await import('./passkey-ceremony.js');

const created = {
  id: 'AQID',
  rawId: 'AQID',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ', extra: 'dropped' },
  clientExtensionResults: { credProps: { rk: true }, appid: true },
  somethingElse: 1,
};

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return isPasskeyCeremonyError(error) ? error.reason : 'not a ceremony error';
  }
};

beforeEach(() => {
  browser.supported = true;
  browser.autofill = true;
  browser.cancelCeremony.mockReset();
  browser.startRegistration.mockReset();
  browser.startAuthentication.mockReset();
});

describe('createPasskey', () => {
  it('hands the options over and sends back only what the api reads', async () => {
    browser.startRegistration.mockResolvedValue(created);

    const response = await createPasskey({ challenge: 'x' });

    expect(browser.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'x' } });
    expect(response).toEqual({
      id: 'AQID',
      rawId: 'AQID',
      type: 'public-key',
      response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it('refuses without trying in a browser with no WebAuthn', async () => {
    browser.supported = false;

    expect(await reasonOf(createPasskey({}))).toBe('unsupported');
    expect(browser.startRegistration).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a dismissed prompt',
      new browser.WebAuthnError(
        'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
        Object.assign(new Error('x'), { name: 'NotAllowedError' }),
      ),
      'cancelled',
    ],
    ['an aborted ceremony', new browser.WebAuthnError('ERROR_CEREMONY_ABORTED'), 'cancelled'],
    [
      'an authenticator already registered',
      new browser.WebAuthnError('ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'),
      'duplicate',
    ],
    ['an invalid RP ID', new browser.WebAuthnError('ERROR_INVALID_RP_ID'), 'failed'],
    ['anything else', new Error('boom'), 'failed'],
  ])('names %s', async (_label, thrown, reason) => {
    browser.startRegistration.mockRejectedValue(thrown);

    expect(await reasonOf(createPasskey({}))).toBe(reason);
  });

  it('refuses an answer that is not the shape the api reads', async () => {
    browser.startRegistration.mockResolvedValue({ id: 'AQID' });

    expect(await reasonOf(createPasskey({}))).toBe('failed');
  });
});

describe('assertPasskey', () => {
  it('sends back the assertion in the api’s shape', async () => {
    browser.startAuthentication.mockResolvedValue({
      id: 'AQID',
      rawId: 'AQID',
      type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    });

    const response = await assertPasskey({ challenge: 'x' });

    expect(response.response.signature).toBe('AAAA');
  });

  it('says a dismissed prompt was cancelled', async () => {
    browser.startAuthentication.mockRejectedValue(new DOMException('no', 'NotAllowedError'));

    expect(await reasonOf(assertPasskey({}))).toBe('cancelled');
  });

  it('asks the browser for its autofill list only when told to', async () => {
    browser.startAuthentication.mockRejectedValue(new DOMException('no', 'NotAllowedError'));

    await reasonOf(assertPasskey({ challenge: 'x' }));
    await reasonOf(assertPasskey({ challenge: 'y' }, { autofill: true }));

    expect(browser.startAuthentication).toHaveBeenNthCalledWith(1, {
      optionsJSON: { challenge: 'x' },
    });
    expect(browser.startAuthentication).toHaveBeenNthCalledWith(2, {
      optionsJSON: { challenge: 'y' },
      useBrowserAutofill: true,
    });
  });
});

describe('passkeyAutofillSupported', () => {
  it('is true only where the browser can run a ceremony and offer an autofill list', async () => {
    expect(await passkeyAutofillSupported()).toBe(true);

    browser.autofill = false;
    expect(await passkeyAutofillSupported()).toBe(false);

    browser.autofill = true;
    browser.supported = false;
    expect(await passkeyAutofillSupported()).toBe(false);
  });
});

describe('cancelPasskeyCeremony', () => {
  it('ends the ceremony the browser is still waiting on', () => {
    cancelPasskeyCeremony();

    expect(browser.cancelCeremony).toHaveBeenCalledOnce();
  });
});
