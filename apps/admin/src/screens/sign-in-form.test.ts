import { describe, expect, it } from 'vitest';
import { validateEmail, validateSignInForm } from './sign-in-form.js';

describe('validateSignInForm', () => {
  it('passes a complete form', () => {
    expect(validateSignInForm({ email: 'lina@helpdock.com', password: 'correct horse' })).toEqual(
      {},
    );
  });

  it('ignores space around the address', () => {
    expect(validateSignInForm({ email: '  lina@helpdock.com ', password: 'x' })).toEqual({});
  });

  it('separates a missing address from a malformed one', () => {
    expect(validateSignInForm({ email: '', password: 'x' })).toEqual({ email: 'required' });
    expect(validateSignInForm({ email: 'lina@', password: 'x' })).toEqual({ email: 'invalid' });
  });

  it('reports both fields at once', () => {
    expect(validateSignInForm({ email: '', password: '' })).toEqual({
      email: 'required',
      password: 'required',
    });
  });
});

describe('validateEmail', () => {
  it('judges the address on its own, because the magic link needs nothing else', () => {
    expect(validateEmail('lina@helpdock.com')).toBeUndefined();
    expect(validateEmail('lina')).toBe('invalid');
  });
});
