import { describe, expect, it } from 'vitest';
import { clientAddressResolver } from './client-address.js';

const CADDY = '172.18.0.2';
const VISITOR = '203.0.113.7';

describe('clientAddressResolver', () => {
  it('reads the visitor from x-forwarded-for when the hop is a proxy the setting names', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    expect(resolve(CADDY, VISITOR)).toBe(VISITOR);
  });

  it('keeps the socket address when the hop is not a proxy the setting names', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    expect(resolve(VISITOR, '198.51.100.1')).toBe(VISITOR);
  });

  it('ignores a forwarded header when no proxy is trusted', () => {
    const resolve = clientAddressResolver(false);

    expect(resolve(CADDY, VISITOR)).toBe(CADDY);
  });

  it('stops at the first hop it does not believe, so a client cannot prepend an address', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    // The client wrote 198.51.100.1 itself; Caddy appended the address it saw.
    expect(resolve(CADDY, `198.51.100.1, ${VISITOR}`)).toBe(VISITOR);
  });

  it('walks through every proxy it believes, as Fastify does', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    expect(resolve(CADDY, `${VISITOR}, 10.0.0.5`)).toBe(VISITOR);
  });

  it('takes the leftmost entry when every hop is believed', () => {
    const resolve = clientAddressResolver(true);

    expect(resolve(CADDY, `198.51.100.1, ${VISITOR}`)).toBe('198.51.100.1');
  });

  it('believes an IPv4 proxy that a dual-stack listener reports in its IPv6 form', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    expect(resolve(`::ffff:${CADDY}`, VISITOR)).toBe(VISITOR);
  });

  it('keeps the proxy when it forwarded no usable address', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    expect(resolve(CADDY, undefined)).toBe(CADDY);
    expect(resolve(CADDY, ' , ')).toBe(CADDY);
  });

  it('returns an entry it cannot parse rather than walking past it', () => {
    const resolve = clientAddressResolver(['uniquelocal']);

    expect(resolve(CADDY, `${VISITOR}, not-an-address`)).toBe('not-an-address');
  });
});
