import type { OAuthApp } from '@helpdock/ai';
import { decryptSecret, encryptSecret, type Keyring, type Settings } from '@helpdock/config';
import { z } from 'zod';

/**
 * A connector source's credential (M7-03): a Notion token — an internal
 * integration's, or the one an OAuth exchange returned — or a Google refresh
 * token. Stored as one `encryptSecret` envelope in
 * `knowledge_sources.config_encrypted` under `APP_MASTER_KEY`, never logged
 * and never returned (AGENTS.md, Secrets).
 */

const credentialSchema = z.discriminatedUnion('service', [
  z.object({ service: z.literal('notion'), token: z.string().min(1) }),
  z.object({ service: z.literal('gdrive'), refreshToken: z.string().min(1) }),
]);
export type ConnectorCredential = z.infer<typeof credentialSchema>;

export const sealCredential = (credential: ConnectorCredential, keyring: Keyring): string =>
  encryptSecret(JSON.stringify(credential), keyring);

export const openCredential = (
  sealed: string | null,
  keyring: Keyring,
): ConnectorCredential | null =>
  sealed === null ? null : credentialSchema.parse(JSON.parse(decryptSecret(sealed, keyring)));

export interface OAuthApps {
  readonly notion: OAuthApp | null;
  readonly gdrive: OAuthApp | null;
}

const appOf = (clientId: string, clientSecret: string): OAuthApp | null =>
  clientId === '' || clientSecret === '' ? null : { clientId, clientSecret };

/** The install's OAuth apps, from `knowledge.*` settings or their `HD_*` overrides. */
export const readOAuthApps = async (settings: Pick<Settings, 'get'>): Promise<OAuthApps> => {
  const [notionId, notionSecret, googleId, googleSecret] = await Promise.all([
    settings.get('knowledge.notion.clientId'),
    settings.get('knowledge.notion.clientSecret'),
    settings.get('knowledge.google.clientId'),
    settings.get('knowledge.google.clientSecret'),
  ]);
  return { notion: appOf(notionId, notionSecret), gdrive: appOf(googleId, googleSecret) };
};
