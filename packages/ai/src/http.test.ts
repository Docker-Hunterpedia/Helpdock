import { describe, expect, it } from 'vitest';
import { AiHttpError, bearer, joinUrl } from './http.js';

describe('joinUrl', () => {
  it('joins a base with or without a trailing slash to a path with or without a leading one', () => {
    expect(joinUrl('https://api.example.com/v1', 'models')).toBe(
      'https://api.example.com/v1/models',
    );
    expect(joinUrl('https://api.example.com/v1/', '/models')).toBe(
      'https://api.example.com/v1/models',
    );
  });

  it('drops any number of slashes at the seam in linear time', () => {
    const started = performance.now();
    expect(joinUrl(`https://a.example${'/'.repeat(100_000)}`, `${'/'.repeat(100_000)}x`)).toBe(
      'https://a.example/x',
    );
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('bearer', () => {
  it('is empty without a key and an authorization header with one', () => {
    expect(bearer(undefined)).toEqual({});
    expect(bearer('')).toEqual({});
    expect(bearer('sk-1')).toEqual({ authorization: 'Bearer sk-1' });
  });
});

describe('AiHttpError', () => {
  it('names the host and the status, never the path', () => {
    const error = new AiHttpError('https://api.example.com/v1/secret-path', 503);
    expect(error.message).toBe('api.example.com answered HTTP 503');
    expect(error.status).toBe(503);
  });
});
