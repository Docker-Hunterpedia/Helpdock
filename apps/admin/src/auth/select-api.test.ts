import { describe, expect, it } from 'vitest';
import { HttpStaffApi } from '../staff/http-api.js';
import { MockStaffApi } from '../staff/mock-api.js';
import { HttpAuthApi } from './http-api.js';
import { MockAuthApi } from './mock-api.js';
import { createApis, resolveAuthApiAdapter } from './select-api.js';

describe('resolveAuthApiAdapter', () => {
  it.each([
    ['mock', true, 'mock'],
    ['http', false, 'http'],
  ])('honours VITE_AUTH_API=%s over the build mode', (configured, production, expected) => {
    expect(resolveAuthApiAdapter(configured, production)).toBe(expected);
  });

  it('defaults a production build to the real service', () => {
    expect(resolveAuthApiAdapter(undefined, true)).toBe('http');
  });

  it.each([undefined, '', 'yes'])('falls back to the fixture outside production (%s)', (value) => {
    expect(resolveAuthApiAdapter(value, false)).toBe('mock');
  });
});

describe('createApis', () => {
  it('builds the adapter it is asked for', () => {
    expect(createApis('mock').auth).toBeInstanceOf(MockAuthApi);
    expect(createApis('mock').staff).toBeInstanceOf(MockStaffApi);
    expect(createApis('http').auth).toBeInstanceOf(HttpAuthApi);
    expect(createApis('http').staff).toBeInstanceOf(HttpStaffApi);
  });
});

describe('HttpAuthApi', () => {
  it('knows where the provider flows start', () => {
    expect(new HttpAuthApi().oauthStartUrl('google')).toBe('/api/auth/oauth/google/start');
  });
});
