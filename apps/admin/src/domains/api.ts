import type {
  CustomDomain,
  CustomDomainList,
  CustomDomainUpdateRequest,
  DomainsRefusal,
} from '@helpdock/schemas';

/**
 * Everything Brand › Domains needs (M5-07). `MockDomainsApi` is the fixture the
 * unit tests and the mock Playwright projects run against; `HttpDomainsApi` is
 * the real service. The same shape as `ChannelsApi`: one interface, two
 * adapters, and refusals that cross as a code the screen picks a sentence for.
 */
export interface DomainsApi {
  domains(brandId: string): Promise<CustomDomainList>;
  addDomain(brandId: string, domain: string): Promise<CustomDomain>;
  /** "Check now": queues a check and answers with the domain as it stands. */
  checkDomain(brandId: string, domainId: string): Promise<CustomDomain>;
  updateDomain(
    brandId: string,
    domainId: string,
    request: CustomDomainUpdateRequest,
  ): Promise<CustomDomain>;
  removeDomain(brandId: string, domainId: string): Promise<void>;
}

export class DomainsError extends Error {
  readonly reason: DomainsRefusal;

  constructor(reason: DomainsRefusal) {
    super(`domains: ${reason}`);
    this.name = 'DomainsError';
    this.reason = reason;
  }
}

export const isDomainsError = (error: unknown): error is DomainsError =>
  error instanceof DomainsError;
