import {
  APIErrorCode,
  Client,
  isFullDatabase,
  isFullPage,
  isNotionClientError,
  iteratePaginatedAPI,
  LogLevel,
} from '@notionhq/client';
import {
  ConnectorAuthError,
  type ConnectorEvent,
  type ConnectorFetch,
  type ConnectorItem,
  type OAuthApp,
  type OAuthTokens,
} from './types.js';

/**
 * Notion as a knowledge source (M7-03, REQUIREMENTS §4.7: "official API,
 * OAuth per brand, selected pages/databases").
 *
 * A brand connects with OAuth through the install's public integration
 * (`knowledge.notion.*`), or pastes an internal integration token; either way
 * the token is stored encrypted on the source and handed here. The person
 * then picks pages and databases; a database contributes every page in each
 * of its data sources. A page is read as Markdown (`GET /pages/:id/markdown`),
 * which keeps its headings for the chunker.
 */

export const NOTION_SERVICE = 'Notion';
const NOTION_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';

export interface NotionConnection {
  readonly token: string;
  readonly fetch: ConnectorFetch;
  /** `https://api.notion.com` unless a test points it at a fake. */
  readonly baseUrl?: string;
}

export interface NotionSelection {
  readonly pageIds: readonly string[];
  readonly databaseIds: readonly string[];
}

const clientFor = ({ token, fetch, baseUrl }: Omit<NotionConnection, 'token'> & { token?: string }) =>
  new Client({
    ...(token === undefined ? {} : { auth: token }),
    fetch,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    logLevel: LogLevel.ERROR,
    logger: () => undefined,
  });

const AUTH_CODES: ReadonlySet<string> = new Set([
  APIErrorCode.Unauthorized,
  APIErrorCode.RestrictedResource,
]);

/** Turns a refused token into {@link ConnectorAuthError}; anything else stays as it was. */
const authAware = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    if (isNotionClientError(error) && AUTH_CODES.has(error.code)) {
      throw new ConnectorAuthError(NOTION_SERVICE, error.message);
    }
    throw error;
  }
};

const plainTitle = (parts: readonly { readonly plain_text: string }[] | undefined): string =>
  (parts ?? []).map((part) => part.plain_text).join('');

/** A page's title property, whatever the property is called. */
const pageTitle = (properties: Readonly<Record<string, { readonly type: string }>>): string => {
  for (const property of Object.values(properties)) {
    if (property.type === 'title') {
      return plainTitle((property as { title?: { plain_text: string }[] }).title);
    }
  }
  return '';
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'the page could not be read';

async function* readPage(client: Client, pageId: string): AsyncGenerator<ConnectorEvent> {
  try {
    const page = await authAware(() => client.pages.retrieve({ page_id: pageId }));
    const title = isFullPage(page) ? pageTitle(page.properties) : '';
    const { markdown } = await authAware(() =>
      client.pages.retrieveMarkdown({ page_id: pageId }),
    );
    yield {
      type: 'document',
      externalId: pageId,
      url: isFullPage(page) ? page.url : null,
      document: { title: title === '' ? 'Untitled' : title, parts: [{ text: markdown }] },
    };
  } catch (error) {
    if (error instanceof ConnectorAuthError) {
      throw error;
    }
    yield { type: 'skipped', externalId: pageId, name: pageId, detail: errorText(error) };
  }
}

/** Every page id of a database, across its data sources. */
async function* databasePages(client: Client, databaseId: string): AsyncGenerator<string> {
  const database = await authAware(() => client.databases.retrieve({ database_id: databaseId }));
  if (!isFullDatabase(database)) {
    return;
  }
  for (const source of database.data_sources) {
    for await (const row of iteratePaginatedAPI(client.dataSources.query, {
      data_source_id: source.id,
    })) {
      if (row.object === 'page') {
        yield row.id;
      }
    }
  }
}

export async function* loadNotion(
  selection: NotionSelection,
  connection: NotionConnection,
  { maxPages }: { readonly maxPages: number },
): AsyncGenerator<ConnectorEvent, void, undefined> {
  const client = clientFor(connection);
  const seen = new Set<string>();
  const pageIds = async function* (): AsyncGenerator<string> {
    yield* selection.pageIds;
    for (const databaseId of selection.databaseIds) {
      yield* databasePages(client, databaseId);
    }
  };

  for await (const pageId of pageIds()) {
    if (seen.has(pageId)) {
      continue;
    }
    if (seen.size >= maxPages) {
      return;
    }
    seen.add(pageId);
    yield* readPage(client, pageId);
  }
}

/** What the token can see, for the picker: pages and databases, best match first. */
export const browseNotion = async (
  connection: NotionConnection,
  query: string,
): Promise<ConnectorItem[]> => {
  const client = clientFor(connection);
  const found = await authAware(() => client.search({ query, page_size: 50 }));
  return found.results.flatMap((result): ConnectorItem[] => {
    if (result.object === 'page' && isFullPage(result)) {
      return [{ id: result.id, title: pageTitle(result.properties) || 'Untitled', kind: 'page' }];
    }
    if (result.object === 'data_source' && 'title' in result) {
      const databaseId =
        'parent' in result && result.parent.type === 'database_id'
          ? result.parent.database_id
          : result.id;
      return [{ id: databaseId, title: plainTitle(result.title) || 'Untitled', kind: 'database' }];
    }
    return [];
  });
};

export const notionAuthorizeUrl = (app: OAuthApp, redirectUri: string, state: string): string => {
  const url = new URL(NOTION_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: 'code',
    owner: 'user',
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.href;
};

export const exchangeNotionCode = async (
  app: OAuthApp,
  { code, redirectUri }: { readonly code: string; readonly redirectUri: string },
  transport: Pick<NotionConnection, 'fetch' | 'baseUrl'>,
): Promise<OAuthTokens> => {
  const answer = await authAware(() =>
    clientFor(transport).oauth.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
  );
  return { accessToken: answer.access_token, refreshToken: answer.refresh_token, expiresAt: null };
};
