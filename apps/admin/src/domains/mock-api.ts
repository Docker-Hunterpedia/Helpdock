import {
  type CustomDomain,
  type CustomDomainList,
  type CustomDomainUpdateRequest,
  MAX_HELPCENTER_DOMAINS,
  txtRecordNameFor,
  txtRecordValueFor,
} from '@helpdock/schemas';
import { type DomainsApi, DomainsError } from './api.js';

/**
 * The Domains fixture: the three rows of `AdminBrandDomains` — a verified
 * primary domain, one waiting for its TXT record, and one Cloudflare proxies
 * without the flag set — for whichever brand asks. What it refuses mirrors the
 * api's refusals closely enough for the screen's error lines to be exercised;
 * the real rules are `@helpdock/net`'s and are tested there.
 */

const CNAME_TARGET = 'edge.helpdock.io';
const NOT_PUBLIC = /\.(local|localhost|internal|test|example|invalid|lan|home|corp|arpa)$/;
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

let sequence = 0;
const nextId = (): string => {
  sequence += 1;
  return `0192c3f0-1a2b-7c3d-8e4f-${sequence.toString(16).padStart(12, '0')}`;
};

const domainRow = (
  domain: string,
  token: string,
  overrides: Partial<CustomDomain> = {},
): CustomDomain => ({
  id: nextId(),
  domain,
  primary: false,
  cloudflareProxied: false,
  state: 'pending',
  tls: null,
  records: {
    cname: { type: 'CNAME', name: domain, value: CNAME_TARGET, seen: false },
    txt: {
      type: 'TXT',
      name: txtRecordNameFor(domain),
      value: txtRecordValueFor(token),
      seen: false,
    },
  },
  failure: null,
  verifiedAt: null,
  tlsIssuedAt: null,
  lastCheckedAt: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  ...overrides,
});

const seen = (row: CustomDomain, cname: boolean, txt: boolean): CustomDomain => ({
  ...row,
  records: {
    cname: { ...row.records.cname, seen: cname },
    txt: { ...row.records.txt, seen: txt },
  },
});

const fixture = (now: number): CustomDomain[] => {
  const minutesAgo = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
  return [
    seen(
      domainRow('help.helpdock.com', '5d2e8a61c0f94b7e93a1d4c6b2e0f718', {
        primary: true,
        state: 'verified',
        tls: 'issued',
        verifiedAt: '2026-09-14T08:00:00.000Z',
        tlsIssuedAt: '2026-09-14T08:01:00.000Z',
        lastCheckedAt: minutesAgo(180),
      }),
      true,
      true,
    ),
    seen(
      domainRow('support.helpdock.com', '7f3a9c2e41b8d05f6a1e0c9d8b7a6f5e', {
        lastCheckedAt: minutesAgo(2),
      }),
      true,
      false,
    ),
    seen(
      domainRow('help.helpdock.sa', 'b41f0e7c9a2d63581e0f4c7b9d2a6e83', {
        state: 'failed',
        verifiedAt: '2026-09-20T10:00:00.000Z',
        failure: { reason: 'cloudflare_not_flagged', detail: '104.21.48.12' },
        lastCheckedAt: minutesAgo(20),
      }),
      false,
      true,
    ),
  ];
};

export class MockDomainsApi implements DomainsApi {
  readonly #byBrand = new Map<string, CustomDomain[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  domains(brandId: string): Promise<CustomDomainList> {
    return Promise.resolve({ cnameTarget: CNAME_TARGET, domains: [...this.#rows(brandId)] });
  }

  addDomain(brandId: string, typed: string): Promise<CustomDomain> {
    const domain = typed.trim().toLowerCase().replace(/\.$/, '');
    const rows = this.#rows(brandId);
    if (!HOSTNAME.test(domain)) {
      return Promise.reject(new DomainsError('domain-invalid'));
    }
    if (NOT_PUBLIC.test(domain)) {
      return Promise.reject(new DomainsError('domain-not-public'));
    }
    if (domain === CNAME_TARGET) {
      return Promise.reject(new DomainsError('domain-reserved'));
    }
    if (rows.some((row) => row.domain === domain)) {
      return Promise.reject(new DomainsError('domain-taken'));
    }
    if (rows.length >= MAX_HELPCENTER_DOMAINS) {
      return Promise.reject(new DomainsError('domain-limit'));
    }

    const row = domainRow(domain, nextId().replaceAll('-', ''), {
      createdAt: new Date(this.#now()).toISOString(),
    });
    rows.push(row);
    return Promise.resolve(row);
  }

  checkDomain(brandId: string, domainId: string): Promise<CustomDomain> {
    return this.#replace(brandId, domainId, (row) => ({
      ...row,
      lastCheckedAt: new Date(this.#now()).toISOString(),
    }));
  }

  updateDomain(
    brandId: string,
    domainId: string,
    request: CustomDomainUpdateRequest,
  ): Promise<CustomDomain> {
    const rows = this.#rows(brandId);
    const target = rows.find((row) => row.id === domainId);
    if (target === undefined) {
      return Promise.reject(new Error('No such domain'));
    }
    if (request.primary === true) {
      if (target.verifiedAt === null) {
        return Promise.reject(new DomainsError('domain-not-verified'));
      }
      for (const [index, row] of rows.entries()) {
        rows[index] = { ...row, primary: row.id === domainId };
      }
    }
    return this.#replace(brandId, domainId, (row) =>
      request.cloudflareProxied === undefined
        ? row
        : {
            ...row,
            cloudflareProxied: request.cloudflareProxied,
            failure: null,
            state: row.verifiedAt === null ? 'pending' : 'verified',
            tls:
              row.verifiedAt === null ? null : request.cloudflareProxied ? 'cloudflare' : 'pending',
          },
    );
  }

  removeDomain(brandId: string, domainId: string): Promise<void> {
    const rows = this.#rows(brandId);
    const index = rows.findIndex((row) => row.id === domainId);
    if (index === -1) {
      return Promise.reject(new Error('No such domain'));
    }
    rows.splice(index, 1);
    return Promise.resolve();
  }

  #rows(brandId: string): CustomDomain[] {
    let rows = this.#byBrand.get(brandId);
    if (rows === undefined) {
      rows = fixture(this.#now());
      this.#byBrand.set(brandId, rows);
    }
    return rows;
  }

  #replace(
    brandId: string,
    domainId: string,
    change: (row: CustomDomain) => CustomDomain,
  ): Promise<CustomDomain> {
    const rows = this.#rows(brandId);
    const index = rows.findIndex((row) => row.id === domainId);
    const row = rows[index];
    if (row === undefined) {
      return Promise.reject(new Error('No such domain'));
    }
    const next = change(row);
    rows[index] = next;
    return Promise.resolve(next);
  }
}
