# @helpdock/net

The SSRF-safe outbound HTTP client. Every Helpdock feature that fetches a URL a
user supplied goes through `safeFetch`: the crawler, webhook delivery, the
remote-image proxy, and the Notion and Google Drive connectors.

Never call global `fetch` on user input. The rule and the behaviour below come
from [DOMAIN-RULES §13](../../docs/planning/DOMAIN-RULES.md#13-outbound-network-safety).

The package has no runtime dependencies. It is built on `node:http` and
`node:https` because their `lookup` option is the only way to send the socket to
the address that was checked while the `Host` header and the TLS SNI name still
carry the hostname the caller asked for. That is what makes DNS rebinding
useless: the name is resolved once, the answer is validated, and the connection
uses that answer. A second resolution never happens.

## Usage

```ts
import { policies, safeFetch, SafeFetchError } from '@helpdock/net';

const response = await safeFetch(
  article.sourceUrl,
  { headers: { 'user-agent': 'Helpdock crawler' } },
  { ...policies.crawl, allowCidrs: config.outboundAllowCidrs, onBlocked: (event) => log.warn(event) },
);

response.status;                 // 200
response.body.toString('utf8');  // raw bytes; nothing is decoded or decompressed
response.url;                    // the URL that answered, after any redirect
response.redirects;              // every URL redirected to, in order
```

`safeFetch(url, init?, policy?)` resolves to
`{ status, headers, body, url, redirects }` and rejects with a
[`SafeFetchError`](#error-codes) for anything else.

### init

| Field | Meaning |
|---|---|
| `method` | Default `GET`. Upper-cased; must be an HTTP token. |
| `headers` | Header names are lower-cased. A `host` header is dropped — it comes from the URL, and letting a caller set it would aim a pinned connection at a different virtual host. |
| `body` | `string` or `Uint8Array`. Buffered rather than streamed, so a 307 or 308 can replay it. `content-length` is set from it. |
| `signal` | An `AbortSignal`. When it fires, `safeFetch` rejects with the signal's own `reason`, not with a `SafeFetchError`. |

## Policy

| Field | Default | Meaning |
|---|---|---|
| `allowedPorts` | `[80, 443, 8080, 8443]` | Ports the destination may use. Applies to the default port of the scheme too. |
| `allowCidrs` | `[]` | CIDRs that override the blocked ranges. See [the allow-list](#the-allow-list). |
| `maxRedirects` | `5` | Redirects followed before `too-many-redirects`. `0` refuses any redirect. |
| `connectTimeoutMs` | `10 000` | Per-hop handshake budget. For HTTPS it covers the TLS handshake. |
| `totalTimeoutMs` | `30 000` | Budget for the whole call, redirects included. |
| `maxBodyBytes` | `10 MB` | Response cap. A declared `content-length` over the cap is refused before the body is read; a body that outgrows it mid-stream aborts the connection. |
| `lookup` | `dns.lookup` with `all: true` | Resolver override. Tests inject one; production does not. |
| `onBlocked` | none | Called for every refused attempt. See [logging](#logging-blocked-attempts). |

A malformed policy — an unparseable CIDR, a negative timeout, a fractional
`maxRedirects` — throws a `TypeError`, not a `SafeFetchError`. That is a
configuration mistake, not a request outcome.

### Presets

`policies` carries the three caps DOMAIN-RULES §13 names. Spread one and
override what you need.

| Preset | Caps |
|---|---|
| `policies.crawl` | 10 MB body |
| `policies.webhook` | 1 MB body, 15 s total |
| `policies.imageProxy` | 20 MB body |

## What is blocked

The scheme must be `http:` or `https:`, the URL must carry no credentials, and
the port must be in `allowedPorts`.

The hostname is resolved with `dns.lookup({ all: true })`, and the request is
refused when **any** returned address is in a blocked range — not only the first
— so a name that answers with one public and one private address cannot be used
to smuggle a request inside. The connection then uses the first address. A
literal IP in the URL goes through the same range check without a lookup.

| Family | Blocked |
|---|---|
| IPv4 | loopback `127.0.0.0/8`, unspecified `0.0.0.0/8`, private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.0.0/16`, CGNAT `100.64.0.0/10`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4`, broadcast `255.255.255.255`, cloud metadata `169.254.169.254` |
| IPv6 | loopback `::1`, unspecified `::`, unique-local `fc00::/7`, link-local `fe80::/10`, multicast `ff00::/8`, cloud metadata `fd00:ec2::254` |
| IPv6 carrying IPv4 | IPv4-mapped `::ffff:0:0/96`, 6to4 `2002::/16`, Teredo `2001::/32` and NAT64 `64:ff9b::/96` are unwrapped and the IPv4 address inside them is checked against the table above. For Teredo both the server address and the obfuscated client address are checked. |

Every hop of a redirect chain is re-validated from scratch: scheme, credentials,
port and resolution. `Authorization` and `Cookie` are dropped when the redirect
crosses an origin. 301, 302 and 303 turn a non-`GET` into a `GET` and drop the
body; 307 and 308 keep both.

### The allow-list

`policy.allowCidrs` is how an operator reaches an internal destination on
purpose — a private Notion proxy on `10.0.0.0/8`, say, or a help-center mirror
on the Docker network. The api populates it from the install-level
`OUTBOUND_ALLOW_CIDRS` setting.

```ts
await safeFetch(url, {}, { ...policies.crawl, allowCidrs: ['10.42.0.0/16'] });
```

An address matched by an entry is permitted even though it sits in a blocked
range. Nothing else changes: the scheme, credential and port rules still apply,
every redirect hop is still checked, and an address outside the listed networks
is still refused. Entries must carry a prefix (`10.0.0.0/8`, not `10.0.0.0`); a
bare address is rejected so a typo cannot silently widen or narrow the list.
IPv4-mapped IPv6 answers are unmapped before matching, so a `10.0.0.0/8` entry
covers `::ffff:10.1.2.3`.

## Error codes

`SafeFetchError.code` is one of:

| Code | When |
|---|---|
| `invalid-url` | Not an absolute URL, or no host. |
| `scheme-not-allowed` | Anything but `http:` or `https:`. |
| `credentials-in-url` | `user:pass@host`. |
| `port-not-allowed` | Port outside `allowedPorts`. |
| `dns-failure` | The resolver failed, or answered with nothing. |
| `destination-blocked` | An address is in a blocked range and is not allow-listed. |
| `too-many-redirects` | More than `maxRedirects` hops. |
| `redirect-blocked` | A hop after the first failed one of the checks. `reason` carries the code of the check it failed, and `cause` the original error. |
| `timeout` | `connectTimeoutMs` or `totalTimeoutMs` elapsed. |
| `body-too-large` | The response exceeded `maxBodyBytes`. |
| `network-error` | The socket failed. |

Every error carries `url`, `host`, `address` and `hop` (`0` is the URL the caller
passed in) so a refusal can be logged with its destination. No part of a response
body is ever put in a message, and the `credentials-in-url` message omits the
URL itself.

### Logging blocked attempts

DOMAIN-RULES §13 requires every blocked attempt to be logged with its
destination. The package imports no logger; it hands the event to a callback
instead.

```ts
await safeFetch(url, {}, {
  ...policies.webhook,
  onBlocked: (event) => log.warn({ ...event }, 'outbound request blocked'),
});
```

The hook fires for `invalid-url`, `scheme-not-allowed`, `credentials-in-url`,
`port-not-allowed`, `dns-failure`, `destination-blocked`, `too-many-redirects`
and `redirect-blocked` — the refusals, not the network failures. A hook that
throws is swallowed: a broken logger must not mask the decision that triggered
it.

## Tests

`pnpm --filter @helpdock/net test`. The behavioural tests run against a real
`node:http` server on 127.0.0.1 and reach it exactly the way an operator would,
through `allowCidrs: ['127.0.0.0/8']`. Every hostname is resolved by an injected
`policy.lookup`, so nothing in the suite touches the internet.
