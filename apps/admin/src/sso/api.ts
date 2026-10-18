import type {
  SsoCertificateDetails,
  SsoConfiguration,
  SsoConnection,
  SsoConnectionDetail,
  SsoConnectionInput,
  SsoMapping,
  SsoRefusal,
  SsoSettings,
  SsoSettingsUpdate,
  SsoTargets,
  SsoTestResult,
} from '@helpdock/schemas';

/** A connection save the api refused by a rule; `domains` names the ones already taken. */
export class SsoError extends Error {
  readonly reason: SsoRefusal;
  readonly domains: readonly string[];

  constructor(reason: SsoRefusal, domains: readonly string[] = []) {
    super(`sso: ${reason}`);
    this.name = 'SsoError';
    this.reason = reason;
    this.domains = domains;
  }
}

export const isSsoError = (error: unknown): error is SsoError => error instanceof SsoError;

export interface SsoApi {
  inspectCertificates(certificates: string[]): Promise<SsoCertificateDetails>;
  saveConfiguration(id: string | null, input: SsoConfiguration): Promise<SsoConnection>;
  connections(): Promise<{ connections: SsoConnection[] }>;
  connection(id: string): Promise<SsoConnectionDetail>;
  create(input: SsoConnectionInput): Promise<SsoConnection>;
  update(id: string, input: SsoConnectionInput): Promise<SsoConnection>;
  remove(id: string): Promise<void>;
  mappings(id: string): Promise<{ mappings: SsoMapping[] }>;
  saveMappings(id: string, mappings: SsoMapping[]): Promise<{ mappings: SsoMapping[] }>;
  settings(): Promise<SsoSettings>;
  saveSettings(input: SsoSettingsUpdate): Promise<SsoSettings>;
  targets(): Promise<SsoTargets>;
  test(id: string): Promise<{ startUrl: string }>;
  testResult(id: string, key: string): Promise<SsoTestResult>;
}

export const ssoKeys = {
  connections: ['sso', 'connections'] as const,
  settings: ['sso', 'settings'] as const,
  targets: ['sso', 'targets'] as const,
  connection: (id: string) => ['sso', 'connection', id] as const,
  mappings: (id: string) => ['sso', 'mappings', id] as const,
  test: (id: string, key: string) => ['sso', 'test', id, key] as const,
};
