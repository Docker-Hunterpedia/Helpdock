import { describe, expect, it } from 'vitest';
import { isOriginAllowed, originOf } from './origin.js';

const ALLOWED = ['https://shop.example.com', 'http://localhost:5173'];

describe('originOf', () => {
  it('reads the origin a browser sent, and nothing else', () => {
    expect(originOf('https://shop.example.com')).toBe('https://shop.example.com');
    expect(originOf(['https://shop.example.com:443'])).toBe('https://shop.example.com');
    expect(originOf('null')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('allows exactly the listed origins', () => {
    expect(isOriginAllowed('https://shop.example.com', ALLOWED)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', ALLOWED)).toBe(true);
    expect(isOriginAllowed('https://shop.example.com.evil.net', ALLOWED)).toBe(false);
    expect(isOriginAllowed('http://shop.example.com', ALLOWED)).toBe(false);
  });

  it('refuses a request with no origin, and everything when the list is empty', () => {
    expect(isOriginAllowed(undefined, ALLOWED)).toBe(false);
    expect(isOriginAllowed('https://shop.example.com', [])).toBe(false);
  });
});
