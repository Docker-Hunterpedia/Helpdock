import {
  type SsoConfiguration,
  type SsoConnectionInput,
  type SsoMapping,
  type SsoSettingsUpdate,
  ssoCertificateDetailsSchema,
  ssoCertificatesSchema,
  ssoConfigurationSchema,
  ssoConnectionCreateSchema,
  ssoConnectionDetailSchema,
  ssoConnectionListSchema,
  ssoConnectionSchema,
  ssoMappingsSchema,
  ssoSettingsSchema,
  ssoSettingsUpdateSchema,
  ssoTargetsSchema,
  ssoTestKeySchema,
  ssoTestResultSchema,
  ssoTestStartSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { SsoApi } from './api.js';

const connectionPath = (id: string) => `/install/sso/connections/${encodeURIComponent(id)}`;
export class HttpSsoApi implements SsoApi {
  constructor(private readonly transport: HttpTransport = new HttpTransport()) {}
  async inspectCertificates(certificates: string[]) {
    return ssoCertificateDetailsSchema.parse(
      await this.transport.request(
        'POST',
        '/install/sso/certificates/inspect',
        ssoCertificatesSchema.parse({ certificates }),
      ),
    );
  }
  async saveConfiguration(id: string | null, input: SsoConfiguration) {
    return ssoConnectionSchema.parse(
      await this.transport.request(
        id === null ? 'POST' : 'PUT',
        id === null ? '/install/sso/configurations' : `${connectionPath(id)}/configuration`,
        ssoConfigurationSchema.parse(input),
      ),
    );
  }
  async connections() {
    return ssoConnectionListSchema.parse(
      await this.transport.request('GET', '/install/sso/connections'),
    );
  }
  async connection(id: string) {
    return ssoConnectionDetailSchema.parse(await this.transport.request('GET', connectionPath(id)));
  }
  async create(input: SsoConnectionInput) {
    return ssoConnectionSchema.parse(
      await this.transport.request(
        'POST',
        '/install/sso/connections',
        ssoConnectionCreateSchema.parse(input),
      ),
    );
  }
  async update(id: string, input: SsoConnectionInput) {
    return ssoConnectionSchema.parse(
      await this.transport.request(
        'PUT',
        connectionPath(id),
        ssoConnectionCreateSchema.parse(input),
      ),
    );
  }
  async remove(id: string) {
    await this.transport.request('DELETE', connectionPath(id));
  }
  async mappings(id: string) {
    return ssoMappingsSchema.parse(
      await this.transport.request('GET', `${connectionPath(id)}/mappings`),
    );
  }
  async saveMappings(id: string, mappings: SsoMapping[]) {
    return ssoMappingsSchema.parse(
      await this.transport.request(
        'PUT',
        `${connectionPath(id)}/mappings`,
        ssoMappingsSchema.parse({ mappings }),
      ),
    );
  }
  async settings() {
    return ssoSettingsSchema.parse(await this.transport.request('GET', '/install/sso/settings'));
  }
  async saveSettings(input: SsoSettingsUpdate) {
    return ssoSettingsSchema.parse(
      await this.transport.request(
        'PUT',
        '/install/sso/settings',
        ssoSettingsUpdateSchema.parse(input),
      ),
    );
  }
  async targets() {
    return ssoTargetsSchema.parse(await this.transport.request('GET', '/install/sso/targets'));
  }
  async test(id: string) {
    return ssoTestStartSchema.parse(
      await this.transport.request('POST', `${connectionPath(id)}/test`),
    );
  }
  async testResult(id: string, key: string) {
    const query = ssoTestKeySchema.parse({ key });
    return ssoTestResultSchema.parse(
      await this.transport.request(
        'GET',
        `${connectionPath(id)}/test?${new URLSearchParams(query)}`,
      ),
    );
  }
}
