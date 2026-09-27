import { describe, expect, it } from 'vitest';
import { parsePublicHostname } from './hostname.js';

describe('parsePublicHostname', () => {
  it('normalises case, surrounding space and one trailing dot', () => {
    expect(parsePublicHostname('  Support.Acme.COM. ')).toEqual({
      ok: true,
      hostname: 'support.acme.com',
    });
  });

  it('accepts punycode labels and a punycode top-level domain', () => {
    expect(parsePublicHostname('xn--mgbh0fb.xn--mgberp4a5d4ar')).toMatchObject({ ok: true });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [`${'a'.repeat(250)}.com`, 'too-long'],
    ['10.0.0.5', 'ip-address'],
    ['[2606:4700::1111]', 'ip-address'],
    ['2606:4700::1111', 'ip-address'],
    ['localhost', 'malformed'],
    ['support', 'malformed'],
    ['-support.acme.com', 'malformed'],
    ['support-.acme.com', 'malformed'],
    ['support..acme.com', 'malformed'],
    ['support.acme.com/path', 'malformed'],
    ['https://support.acme.com', 'malformed'],
    ['support_desk.acme.com', 'malformed'],
    ['hëlp.acme.com', 'malformed'],
    ['support.acme.123', 'malformed'],
    ['app.localhost', 'not-public'],
    ['printer.local', 'not-public'],
    ['db.internal', 'not-public'],
    ['router.home.arpa', 'not-public'],
    ['help.acme.test', 'not-public'],
    ['help.example', 'not-public'],
  ])('refuses %j as %s', (input, problem) => {
    expect(parsePublicHostname(input)).toEqual({ ok: false, problem });
  });
});
