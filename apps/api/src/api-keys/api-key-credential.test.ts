import { API_KEY_PREFIX } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { hashApiKey, isApiKey, issueApiKey } from './api-key-credential.js';

describe('issueApiKey', () => {
  it('issues an hd_live_ key, stores only its SHA-256, and keeps a short prefix for display', () => {
    const issued = issueApiKey();

    expect(issued.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(issued.hash).toBe(hashApiKey(issued.key));
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).not.toContain(issued.key);
    expect(issued.prefix).toBe(issued.key.slice(0, 12));
  });

  it('never issues the same key twice', () => {
    expect(issueApiKey().key).not.toBe(issueApiKey().key);
  });
});

describe('isApiKey', () => {
  it('tells an API key from an access token', () => {
    expect(isApiKey('hd_live_abc')).toBe(true);
    expect(isApiKey('eyJhbGciOiJFUzI1NiJ9.e30.sig')).toBe(false);
  });
});
