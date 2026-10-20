import { describe, expect, it } from 'vitest';
import { relyingPartyFor } from './relying-party.js';

describe('relyingPartyFor', () => {
  it("takes the RP ID from APP_URL's host and the origin from its origin", () => {
    expect(relyingPartyFor('https://Desk.Example.com:8443/admin')).toEqual({
      id: 'desk.example.com',
      origin: 'https://desk.example.com:8443',
    });
  });

  it('allows plain http on localhost, for development', () => {
    expect(relyingPartyFor('http://localhost:3000')).toEqual({
      id: 'localhost',
      origin: 'http://localhost:3000',
    });
  });

  it.each([
    ['plain http on a real host', 'http://desk.example.com'],
    ['an IPv4 address', 'https://192.0.2.10'],
    ['an IPv6 address', 'https://[2001:db8::1]'],
    ['plain http on a loopback address', 'http://127.0.0.1:3000'],
    ['a host with an underscore, which the RP ID pin cannot hold', 'https://desk_1.example.com'],
    ['a host with a trailing dot', 'https://desk.example.com.'],
  ])('has no relying party on %s', (_case, appUrl) => {
    expect(relyingPartyFor(appUrl)).toBeNull();
  });
});
