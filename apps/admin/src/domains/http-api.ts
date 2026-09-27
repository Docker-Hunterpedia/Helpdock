import {
  type CustomDomain,
  type CustomDomainList,
  type CustomDomainUpdateRequest,
  customDomainListSchema,
  customDomainSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { DomainsApi } from './api.js';

/**
 * The real Domains service. It shares the app's {@link HttpTransport}, so the
 * access token and its refresh are the ones every other screen uses, and parses
 * every answer through the schema the api declared it with.
 */
export class HttpDomainsApi implements DomainsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async domains(brandId: string): Promise<CustomDomainList> {
    return customDomainListSchema.parse(
      await this.#transport.request('GET', this.#domains(brandId)),
    );
  }

  async addDomain(brandId: string, domain: string): Promise<CustomDomain> {
    return customDomainSchema.parse(
      await this.#transport.request('POST', this.#domains(brandId), { domain }),
    );
  }

  async checkDomain(brandId: string, domainId: string): Promise<CustomDomain> {
    return customDomainSchema.parse(
      await this.#transport.request('POST', `${this.#domain(brandId, domainId)}/check`),
    );
  }

  async updateDomain(
    brandId: string,
    domainId: string,
    request: CustomDomainUpdateRequest,
  ): Promise<CustomDomain> {
    return customDomainSchema.parse(
      await this.#transport.request('PATCH', this.#domain(brandId, domainId), request),
    );
  }

  async removeDomain(brandId: string, domainId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#domain(brandId, domainId));
  }

  #domains(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/domains`;
  }

  #domain(brandId: string, domainId: string): string {
    return `${this.#domains(brandId)}/${encodeURIComponent(domainId)}`;
  }
}
