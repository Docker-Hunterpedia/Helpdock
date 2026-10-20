import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

type Route = {
  match?: { host?: string[]; path?: string[] }[];
  handle?: Route[];
  routes?: Route[];
  handler?: string;
  status_code?: number;
  upstreams?: { dial: string }[];
  headers?: { request?: { set?: Record<string, string[]> } };
};
type AdaptedConfig = { apps: { http: { servers: Record<string, { routes: Route[] }> } } };

function descendants(route: Route): Route[] {
  return [
    route,
    ...(route.handle ?? []).flatMap(descendants),
    ...(route.routes ?? []).flatMap(descendants),
  ];
}

describe.each(['Caddyfile', 'Caddyfile.cloudflare'])('%s inbound parse routing (#345)', (file) => {
  let sites: Route[];

  beforeAll(() => {
    let source = readFileSync(new URL(`../docker/caddy/${file}`, import.meta.url), 'utf8');
    // Exercise the shipped example for manually configured Cloudflare brand hosts too.
    if (file.endsWith('.cloudflare')) {
      source = source.replace(
        /^# (help\.brand-a\.example.*|\timport helpdock_upstream|\})$/gm,
        '$1',
      );
    }
    const config: AdaptedConfig = JSON.parse(
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '-e',
          'ADMIN_HOST=admin.example.test',
          '-e',
          'API_HOST=api.example.test',
          '-e',
          'ACME_EMAIL=ops@example.test',
          'mirror.gcr.io/library/caddy:2',
          'caddy',
          'adapt',
          '--config',
          '/dev/stdin',
          '--adapter',
          'caddyfile',
        ],
        { input: source, encoding: 'utf8', timeout: 120_000 },
      ),
    );
    sites = Object.values(config.apps.http.servers).flatMap((server) => server.routes);
  }, 120_000);

  it.each(['api.example.test', 'admin.example.test'])(
    'proxies parse before the internal 404 on %s',
    (host) => {
      const site = sites.find((route) =>
        route.match?.some((matcher) => matcher.host?.includes(host)),
      );
      expect(site).toBeDefined();
      const paths = descendants(site as Route).filter((route) =>
        route.match?.some((matcher) => matcher.path),
      );
      expect(paths.map((route) => route.match)).toEqual([
        [{ path: ['/internal/inbound-parse/*'] }],
        [{ path: ['/internal/*'] }],
      ]);
      const proxy = descendants(paths[0] as Route).find(
        (route) => route.handler === 'reverse_proxy',
      );
      expect(proxy?.upstreams).toEqual([{ dial: 'api:3000' }]);
      expect(proxy?.headers?.request?.set?.['X-Request-Id']).toEqual(['{http.request.uuid}']);
      const proxies = descendants(site as Route).filter(
        (route) => route.handler === 'reverse_proxy',
      );
      expect(proxies).toHaveLength(2);
      expect(proxies[1]).toEqual(proxy);
      expect(descendants(paths[0] as Route).some((route) => route.handler === 'rewrite')).toBe(
        false,
      );
      expect(descendants(paths[1] as Route)).toContainEqual(
        expect.objectContaining({
          handler: 'static_response',
          status_code: 404,
        }),
      );
    },
  );

  it('keeps every internal path blocked on brand help-center hosts', () => {
    const brands = sites.filter(
      (route) =>
        !route.match?.some((matcher) =>
          matcher.host?.some((host) => ['api.example.test', 'admin.example.test'].includes(host)),
        ),
    );
    expect(brands).toHaveLength(1);
    const paths = brands
      .flatMap(descendants)
      .filter((route) => route.match?.some((matcher) => matcher.path));
    expect(paths.map((route) => route.match)).toEqual([[{ path: ['/internal/*'] }]]);
    expect(descendants(paths[0] as Route)).toContainEqual(
      expect.objectContaining({
        handler: 'static_response',
        status_code: 404,
      }),
    );
  });
});
