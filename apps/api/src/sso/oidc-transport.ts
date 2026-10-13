import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { addressInCidrs, type LookupFunction, resolvePublicHost, safeFetch } from '@helpdock/net';
import type { CustomFetch, ServerMetadata } from 'openid-client';
import { OidcFailure } from './oidc-contracts.js';

export function oidcHttpLookup(
  allowCidrs: readonly string[],
  resolve: LookupFunction = (hostname) => dnsLookup(hostname, { all: true }),
): LookupFunction {
  return async (hostname) => {
    const addresses = await resolve(hostname);
    if (!addresses.length || addresses.some(({ address }) => !addressInCidrs(address, allowCidrs)))
      throw new OidcFailure('sso-https-required');
    return addresses;
  };
}

/** Redirects are refused even for discovery: a 307 must never forward a token-request secret. */
export function oidcTransport(allowCidrs: readonly string[]): CustomFetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const http = url.protocol === 'http:';
    if (url.protocol !== 'https:' && !http) throw new OidcFailure('sso-https-required');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (http && isIP(hostname) && !addressInCidrs(hostname, allowCidrs))
      throw new OidcFailure('sso-https-required');
    const body = init?.body;
    if (
      body !== undefined &&
      body !== null &&
      !(typeof body === 'string' || body instanceof URLSearchParams || body instanceof Uint8Array)
    ) {
      throw new OidcFailure('sso-request-body-unsupported');
    }
    const result = await safeFetch(
      url,
      {
        method: init?.method,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          'accept-encoding': 'identity',
        },
        ...(body == null ? {} : { body: body instanceof Uint8Array ? body : String(body) }),
        ...(init?.signal == null ? {} : { signal: init.signal }),
      },
      {
        allowCidrs,
        // The resolver whose answers are pinned to the socket also enforces HTTP's CIDR-only exception.
        ...(http ? { lookup: oidcHttpLookup(allowCidrs) } : {}),
        maxRedirects: 0,
        totalTimeoutMs: 10_000,
        maxBodyBytes: 1024 * 1024,
      },
    );
    return new Response(result.status === 204 ? null : new Uint8Array(result.body), {
      status: result.status,
      headers: Object.fromEntries(
        Object.entries(result.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(', ') : value,
        ]),
      ),
    });
  };
}

export async function validateOidcEndpoints(
  metadata: ServerMetadata,
  allowCidrs: readonly string[],
): Promise<void> {
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri)
    throw new OidcFailure('sso-discovery-incomplete');
  for (const raw of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
    metadata.userinfo_endpoint,
  ]) {
    if (!raw) continue;
    await validateSsoEndpoint(raw, allowCidrs);
  }
}

export async function validateSsoEndpoint(raw: string, allowCidrs: readonly string[]) {
  const endpoint = new URL(raw);
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new OidcFailure('sso-endpoint-invalid');
  const host = await resolvePublicHost(endpoint.hostname, { allowCidrs });
  if (endpoint.protocol === 'http:' && !addressInCidrs(host.address, allowCidrs))
    throw new OidcFailure('sso-https-required');
}
