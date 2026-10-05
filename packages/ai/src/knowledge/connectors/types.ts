import type { ExtractedDocument } from '../chunker.js';

/**
 * What the Notion and Google Drive connectors (M7-03) share: the documents
 * they stream to the sync job, and the errors it tells apart.
 *
 * Both connectors make every request through the `fetch` they are handed,
 * which the api binds to the SSRF-safe client (DOMAIN-RULES §13 names both
 * connectors); a test hands them a fake, so no suite reaches either service.
 */

export type ConnectorFetch = typeof fetch;

export type ConnectorEvent =
  | {
      readonly type: 'document';
      /** The service's own id, which a re-sync updates rather than duplicates. */
      readonly externalId: string;
      readonly url: string | null;
      readonly document: ExtractedDocument;
    }
  | {
      readonly type: 'skipped';
      readonly externalId: string;
      readonly name: string;
      readonly detail: string;
    };

/** Something the person connecting can pick: a page, a database, a folder. */
export interface ConnectorItem {
  readonly id: string;
  readonly title: string;
  readonly kind: 'page' | 'database' | 'folder';
}

/**
 * The service refused the credentials: revoked, expired past refreshing, or
 * never granted. The source shows "Reconnect" rather than a plain failure.
 */
export class ConnectorAuthError extends Error {
  constructor(service: string, detail: string) {
    super(`${service} refused the connection: ${detail}`);
    this.name = 'ConnectorAuthError';
  }
}

/** The tokens an OAuth exchange answers with, stored encrypted on the source. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds, when the service said. */
  readonly expiresAt: number | null;
}

/** The install's OAuth app for one service (`knowledge.notion.*`, `knowledge.google.*`). */
export interface OAuthApp {
  readonly clientId: string;
  readonly clientSecret: string;
}
