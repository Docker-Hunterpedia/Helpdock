import type { PushSubscriptionCreate } from '@helpdock/schemas';

/**
 * This browser's half of web push (ADR 0002): whether it may, the permission
 * prompt, the service worker, and the subscription it hands the api.
 *
 * An interface because the real one needs a push service a test browser does
 * not have. `MockBrowserPush` stands in for it in the unit tests and the mock
 * Playwright projects, the way the other mock adapters stand in for the api.
 */

/** `unsupported`: no service worker or no PushManager (an http origin, an old browser). */
export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** The permission prompt was answered "no", or the browser answered for the person. */
export class PushDeniedError extends Error {
  constructor() {
    super('push permission denied');
    this.name = 'PushDeniedError';
  }
}

export interface BrowserPush {
  permission(): PushPermission;
  /** Whether this browser holds a push subscription now. */
  subscribed(): Promise<boolean>;
  /** Asks for permission if it has to, subscribes, and returns what the api stores. */
  subscribe(publicKey: string): Promise<PushSubscriptionCreate>;
  unsubscribe(): Promise<void>;
  /** "Chrome" and "macOS", for "Chrome on macOS". Names, so never translated. */
  device(): { readonly browser: string; readonly os: string };
}

/** The service worker the admin build serves at its root (`public/sw.js`). */
export const SERVICE_WORKER_URL = '/sw.js';

/** A VAPID public key as base64url, as `applicationServerKey` wants it: bytes. */
export const applicationServerKey = (base64url: string): Uint8Array<ArrayBuffer> => {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

/** Browser and OS from a user agent, coarse on purpose: it is a label, not a fingerprint. */
export const deviceOf = (userAgent: string): { browser: string; os: string } => {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'this device';

  return { browser, os };
};

/* c8 ignore start -- the real browser half: a test browser has no push service to subscribe to. */
export class NavigatorBrowserPush implements BrowserPush {
  permission(): PushPermission {
    if (
      typeof navigator === 'undefined' ||
      !('serviceWorker' in navigator) ||
      typeof window === 'undefined' ||
      !('PushManager' in window) ||
      typeof Notification === 'undefined'
    ) {
      return 'unsupported';
    }

    return Notification.permission;
  }

  async subscribed(): Promise<boolean> {
    if (this.permission() === 'unsupported') {
      return false;
    }
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);

    return (await registration?.pushManager.getSubscription()) != null;
  }

  async subscribe(publicKey: string): Promise<PushSubscriptionCreate> {
    if ((await Notification.requestPermission()) !== 'granted') {
      throw new PushDeniedError();
    }

    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });
    const json = subscription.toJSON();
    const { browser, os } = this.device();

    return {
      endpoint: json.endpoint ?? subscription.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      label: `${browser} · ${os}`,
    };
  }

  async unsubscribe(): Promise<void> {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  }

  device(): { browser: string; os: string } {
    return deviceOf(navigator.userAgent);
  }
}
/* c8 ignore stop */

/**
 * What a mock Playwright project sets to make the permission prompt answer
 * "block", so the "Blocked by the browser" card is reachable without a real
 * push service.
 */
export const MOCK_PUSH_PERMISSION_STORAGE = 'helpdock.mock.pushPermission';

export class MockBrowserPush implements BrowserPush {
  #permission: PushPermission;
  #subscribed = false;
  readonly #answer: 'granted' | 'denied';

  constructor({
    permission = 'default',
    answer = readAnswer(),
  }: { permission?: PushPermission; answer?: 'granted' | 'denied' } = {}) {
    this.#permission = permission;
    this.#answer = answer;
  }

  permission(): PushPermission {
    return this.#permission;
  }

  async subscribed(): Promise<boolean> {
    return this.#subscribed;
  }

  async subscribe(_publicKey: string): Promise<PushSubscriptionCreate> {
    if (this.#permission === 'default') {
      this.#permission = this.#answer;
    }
    if (this.#permission !== 'granted') {
      throw new PushDeniedError();
    }

    this.#subscribed = true;

    return {
      endpoint: 'https://push.example.com/mock-browser',
      keys: { p256dh: 'BMockPublicKey', auth: 'MockAuthSecret' },
      label: 'Chrome · macOS',
    };
  }

  async unsubscribe(): Promise<void> {
    this.#subscribed = false;
  }

  device(): { browser: string; os: string } {
    return { browser: 'Chrome', os: 'macOS' };
  }
}

const readAnswer = (): 'granted' | 'denied' => {
  try {
    return globalThis.localStorage?.getItem(MOCK_PUSH_PERMISSION_STORAGE) === 'denied'
      ? 'denied'
      : 'granted';
  } catch {
    return 'granted';
  }
};
