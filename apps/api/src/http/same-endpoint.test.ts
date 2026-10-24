import { describe, expect, it } from 'vitest';
import { sameEndpoint } from './same-endpoint.js';

describe('sameEndpoint', () => {
  it.each([
    ['https://api.example.com/v1', 'https://api.example.com/v1/'],
    ['HTTPS://API.Example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com:443/v1', 'https://api.example.com/v1'],
    ['https://api.example.com', 'https://api.example.com/'],
    [' https://api.example.com/v1 ', 'https://api.example.com/v1'],
  ])('treats %s and %s as the same endpoint', (a, b) => {
    expect(sameEndpoint(a, b)).toBe(true);
  });

  it.each([
    ['https://api.example.com/v1', 'https://evil.example.net/v1'],
    ['https://api.example.com/v1', 'http://api.example.com/v1'],
    ['https://api.example.com/v1', 'https://api.example.com:8443/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v2'],
    ['https://api.example.com/v1', 'https://api.example.com/v1?x=1'],
    ['https://api.example.com', 'https://api.example.com.evil.net'],
  ])('treats %s and %s as different', (a, b) => {
    expect(sameEndpoint(a, b)).toBe(false);
  });

  it('compares null only with null', () => {
    expect(sameEndpoint(null, null)).toBe(true);
    expect(sameEndpoint(null, 'https://api.example.com')).toBe(false);
    expect(sameEndpoint('https://api.example.com', null)).toBe(false);
  });

  it('never matches a value that is not a URL', () => {
    expect(sameEndpoint('not a url', 'not a url')).toBe(false);
  });
});
