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

/**
 * Set to a number of milliseconds before the app loads, it makes the fixture's
 * save take that long, which is how a browser test sees the switch while it
 * is being saved.
 */
export const MOCK_KEYBOARD_SAVE_DELAY_STORAGE = 'helpdock.mock.keyboardSaveDelayMs';

const seededSaveDelay = (): number => {
  try {
    return Number(globalThis.localStorage?.getItem(MOCK_KEYBOARD_SAVE_DELAY_STORAGE) ?? 0) || 0;
  } catch {
    return 0;
  }
};

/** Saves to the auth fixture's account, so the next `me()` carries the switch as the api's would. */
export class MockKeyboardApi implements KeyboardApi {
  readonly #auth: MockAuthApi | undefined;
  readonly #delayMs = seededSaveDelay();

  constructor(auth?: MockAuthApi) {
    this.#auth = auth;
  }

  async save(preferences: KeyboardPreferences): Promise<KeyboardPreferences> {
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    this.#auth?.saveSingleKeyShortcuts(preferences.singleKeyShortcuts);
    return { singleKeyShortcuts: preferences.singleKeyShortcuts };
  }
}
