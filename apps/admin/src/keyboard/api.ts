import { type KeyboardPreferences, keyboardPreferencesSchema } from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';

/**
 * The person's keyboard settings (M14-01): `/api/me/keyboard`.
 * `MockKeyboardApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpKeyboardApi` is the real service.
 */
export interface KeyboardApi {
  preferences(): Promise<KeyboardPreferences>;
  save(preferences: KeyboardPreferences): Promise<KeyboardPreferences>;
}

export class HttpKeyboardApi implements KeyboardApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async preferences(): Promise<KeyboardPreferences> {
    return keyboardPreferencesSchema.parse(await this.#transport.request('GET', '/me/keyboard'));
  }

  async save(preferences: KeyboardPreferences): Promise<KeyboardPreferences> {
    return keyboardPreferencesSchema.parse(
      await this.#transport.request('PUT', '/me/keyboard', preferences),
    );
  }
}

/**
 * Set to `off` before the app loads, it makes the fixture's account start with
 * single-key shortcuts off, which is how a browser test proves the switch is
 * read from the account rather than from the browser.
 */
export const MOCK_SINGLE_KEY_STORAGE = 'helpdock.mock.singleKeyShortcuts';

const initiallyOn = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(MOCK_SINGLE_KEY_STORAGE) !== 'off';
  } catch {
    return true;
  }
};

export class MockKeyboardApi implements KeyboardApi {
  #preferences: KeyboardPreferences = { singleKeyShortcuts: initiallyOn() };

  preferences(): Promise<KeyboardPreferences> {
    return Promise.resolve(this.#preferences);
  }

  save(preferences: KeyboardPreferences): Promise<KeyboardPreferences> {
    this.#preferences = { singleKeyShortcuts: preferences.singleKeyShortcuts };
    return Promise.resolve(this.#preferences);
  }
}
