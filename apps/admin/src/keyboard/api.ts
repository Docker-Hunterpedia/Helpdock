import { type KeyboardPreferences, keyboardPreferencesSchema } from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { MockAuthApi } from '../auth/mock-api.js';

/**
 * Saving the person's keyboard settings (M14-01): `PUT /api/me/keyboard`.
 * Reading them needs no call of its own: the session carries the switch
 * (`Session['user'].singleKeyShortcuts`), so the shell knows it before it
 * draws. `MockKeyboardApi` is the fixture the unit tests and the mock
 * Playwright projects run against; `HttpKeyboardApi` is the real service.
 */
export interface KeyboardApi {
  save(preferences: KeyboardPreferences): Promise<KeyboardPreferences>;
}

export class HttpKeyboardApi implements KeyboardApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async save(preferences: KeyboardPreferences): Promise<KeyboardPreferences> {
    return keyboardPreferencesSchema.parse(
      await this.#transport.request('PUT', '/me/keyboard', preferences),
    );
  }
}

/** Saves to the auth fixture's account, so the next `me()` carries the switch as the api's would. */
export class MockKeyboardApi implements KeyboardApi {
  readonly #auth: MockAuthApi | undefined;

  constructor(auth?: MockAuthApi) {
    this.#auth = auth;
  }

  save(preferences: KeyboardPreferences): Promise<KeyboardPreferences> {
    this.#auth?.saveSingleKeyShortcuts(preferences.singleKeyShortcuts);
    return Promise.resolve({ singleKeyShortcuts: preferences.singleKeyShortcuts });
  }
}
