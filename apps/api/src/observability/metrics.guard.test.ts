import type { Env } from '@helpdock/config';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logging/logger.js';
import { fakeExecutionContext } from '../testing/execution-context.js';
import { MetricsGuard } from './metrics.guard.js';

const envWith = ({
  metricsToken,
  trustProxy = false,
}: {
  readonly metricsToken?: string;
  readonly trustProxy?: boolean;
} = {}): Env =>
  ({
    TRUST_PROXY: trustProxy,
    ...(metricsToken === undefined ? {} : { METRICS_TOKEN: metricsToken }),
  }) as Env;

const requestFrom = ({
  remoteAddress,
  authorization,
  forwardedFor,
}: {
  readonly remoteAddress?: string | undefined;
  readonly authorization?: string;
  readonly forwardedFor?: string;
}) => ({
  socket: { remoteAddress },
  ip: forwardedFor ?? remoteAddress,
  headers: {
    ...(authorization === undefined ? {} : { authorization }),
    ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
  },
});

const recorder = () => {
  const warn = vi.fn();
  return { warn, logger: { warn } as unknown as Logger };
};

const TOKEN = 'a-metrics-token-long-enough';

describe('MetricsGuard', () => {
  it('lets the private network through', () => {
    const guard = new MetricsGuard(envWith(), recorder().logger);
    const context = fakeExecutionContext({ request: requestFrom({ remoteAddress: '172.18.0.4' }) });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('lets a configured bearer through from anywhere', () => {
    const guard = new MetricsGuard(envWith({ metricsToken: TOKEN }), recorder().logger);
    const context = fakeExecutionContext({
      request: requestFrom({
        remoteAddress: '198.51.100.9',
        authorization: `Bearer ${TOKEN}`,
      }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('answers 404 rather than 401, so the endpoint is not advertised', () => {
    const guard = new MetricsGuard(envWith({ metricsToken: TOKEN }), recorder().logger);
    const context = fakeExecutionContext({
      request: requestFrom({ remoteAddress: '198.51.100.9' }),
    });

    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });

  it('will not be talked into a private address by x-forwarded-for', () => {
    const guard = new MetricsGuard(envWith(), recorder().logger);
    const context = fakeExecutionContext({
      request: requestFrom({ remoteAddress: '198.51.100.9', forwardedFor: '127.0.0.1' }),
    });

    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });

  /**
   * Behind a proxy the socket peer is the proxy, which is on the private
   * network — so without this the address check would admit anything the proxy
   * forwarded, including a request from the internet.
   */
  it('requires the token once a trusted proxy is in front, whatever the peer address is', () => {
    const guard = new MetricsGuard(
      envWith({ metricsToken: TOKEN, trustProxy: true }),
      recorder().logger,
    );
    const proxied = {
      remoteAddress: '172.18.0.2',
      forwardedFor: '203.0.113.5',
    };

    expect(() =>
      guard.canActivate(fakeExecutionContext({ request: requestFrom(proxied) })),
    ).toThrow(NotFoundException);

    expect(
      guard.canActivate(
        fakeExecutionContext({
          request: requestFrom({ ...proxied, authorization: `Bearer ${TOKEN}` }),
        }),
      ),
    ).toBe(true);
  });

  it('still admits a sidecar that dials the port itself while a proxy is configured', () => {
    const guard = new MetricsGuard(envWith({ trustProxy: true }), recorder().logger);
    const context = fakeExecutionContext({ request: requestFrom({ remoteAddress: '172.18.0.9' }) });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('logs why a scrape was refused, without the token that was presented', () => {
    const { warn, logger } = recorder();
    const guard = new MetricsGuard(envWith({ metricsToken: TOKEN }), logger);

    expect(() =>
      guard.canActivate(
        fakeExecutionContext({
          request: requestFrom({
            remoteAddress: '198.51.100.9',
            authorization: 'Bearer a-wrong-token-value',
          }),
        }),
      ),
    ).toThrow(NotFoundException);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ peer: '198.51.100.9', bearerPresented: true }),
      expect.stringContaining('/metrics'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('a-wrong-token-value');
  });

  it('says nothing when it lets a scrape through', () => {
    const { warn, logger } = recorder();
    const guard = new MetricsGuard(envWith(), logger);

    guard.canActivate(fakeExecutionContext({ request: requestFrom({ remoteAddress: '::1' }) }));

    expect(warn).not.toHaveBeenCalled();
  });
});
