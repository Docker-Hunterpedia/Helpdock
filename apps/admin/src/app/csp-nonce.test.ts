import { afterEach, describe, expect, it } from 'vitest';
import { CSP_NONCE_META, readCspNonce } from './csp-nonce.js';

afterEach(() => {
  document.head.replaceChildren();
});

describe('readCspNonce', () => {
  it('reads the nonce injected into the production document', () => {
    const meta = document.createElement('meta');
    meta.name = CSP_NONCE_META;
    meta.content = 'response-nonce';
    document.head.append(meta);

    expect(readCspNonce()).toBe('response-nonce');
  });

  it('leaves Vite development without a nonce requirement', () => {
    expect(readCspNonce()).toBeUndefined();
  });
});
