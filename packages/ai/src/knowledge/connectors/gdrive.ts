import { auth, drive, type drive_v3 } from 'googleapis/build/src/apis/drive/index.js';
import type { ExtractedDocument } from '../chunker.js';
import { extractFile, KNOWLEDGE_FILE_MAX_BYTES } from '../files.js';
import { htmlToText } from '../html.js';
import {
  ConnectorAuthError,
  type ConnectorEvent,
  type ConnectorFetch,
  type ConnectorItem,
  type OAuthApp,
  type OAuthTokens,
} from './types.js';

/**
 * Google Drive as a knowledge source (M7-03, REQUIREMENTS §4.7: "Docs, Sheets,
 * PDF, OAuth per brand, selected folders"), through `googleapis`.
 *
 * A brand connects with OAuth through the install's Google Cloud app
 * (`knowledge.google.*`), read-only scope; the refresh token is stored
 * encrypted on the source. A sync walks each picked folder and its
 * subfolders: Google Docs are exported as HTML (headings kept), Sheets as
 * CSV, and PDF, DOCX, Markdown and text files are downloaded and read like an
 * upload. Anything else, and any file over the upload cap, is skipped and
 * logged.
 *
 * Only the Drive module of `googleapis` is loaded, not its hundreds of APIs.
 */

export const DRIVE_SERVICE = 'Google Drive';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FOLDER = 'application/vnd.google-apps.folder';
/** Subfolders below a picked folder that a sync descends into. */
export const MAX_FOLDER_DEPTH = 5;

export interface DriveConnection {
  readonly app: OAuthApp;
  readonly refreshToken: string;
  readonly fetch: ConnectorFetch;
  /** `https://www.googleapis.com/` unless a test points it at a fake. */
  readonly rootUrl?: string;
  /** `https://oauth2.googleapis.com/token` unless a test points it at a fake. */
  readonly tokenUrl?: string;
}

export interface DriveSelection {
  readonly folderIds: readonly string[];
}

type OAuthClient = InstanceType<typeof auth.OAuth2>;

const oauthClient = (
  app: OAuthApp,
  transport: Pick<DriveConnection, 'fetch' | 'tokenUrl'>,
  redirectUri?: string,
): OAuthClient =>
  new auth.OAuth2({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    ...(redirectUri === undefined ? {} : { redirectUri }),
    ...(transport.tokenUrl === undefined
      ? {}
      : { endpoints: { oauth2TokenUrl: transport.tokenUrl } }),
    transporterOptions: { fetchImplementation: transport.fetch },
  });

const driveFor = (connection: DriveConnection): drive_v3.Drive => {
  const client = oauthClient(connection.app, connection);
  client.setCredentials({ refresh_token: connection.refreshToken });
  return drive({
    version: 'v3',
    auth: client,
    fetchImplementation: connection.fetch,
    ...(connection.rootUrl === undefined ? {} : { rootUrl: connection.rootUrl }),
  });
};

const statusOf = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null) {
    const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
    const value = typeof status === 'number' ? status : response?.status;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
};

/** A refused or revoked grant is {@link ConnectorAuthError}; Google answers 400 `invalid_grant` or 401. */
const authAware = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    const status = statusOf(error);
    const message = error instanceof Error ? error.message : '';
    if (status === 401 || message.includes('invalid_grant')) {
      throw new ConnectorAuthError(DRIVE_SERVICE, message || 'unauthorized');
    }
    throw error;
  }
};

const listChildren = async function* (
  client: drive_v3.Drive,
  folderId: string,
): AsyncGenerator<drive_v3.Schema$File> {
  let pageToken: string | undefined;
  do {
    const { data } = await authAware(() =>
      client.files.list({
        q: `'${folderId.replace(/['\\]/g, '')}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink)',
        pageSize: 100,
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
    );
    yield* data.files ?? [];
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
};

const exportText = async (
  client: drive_v3.Drive,
  fileId: string,
  mimeType: string,
): Promise<string> => {
  const { data } = await authAware(() =>
    client.files.export({ fileId, mimeType }, { responseType: 'text' }),
  );
  return String(data);
};

const download = async (client: drive_v3.Drive, fileId: string): Promise<Uint8Array> => {
  const { data } = await authAware(() =>
    client.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }),
  );
  return new Uint8Array(data as unknown as ArrayBuffer);
};

/** The document for one Drive file, or why it was skipped. */
const readFile = async (
  client: drive_v3.Drive,
  file: drive_v3.Schema$File,
): Promise<ExtractedDocument | string> => {
  const id = file.id ?? '';
  const name = file.name ?? id;
  if (Number(file.size ?? 0) > KNOWLEDGE_FILE_MAX_BYTES) {
    return 'larger than the 25 MB upload cap';
  }
  switch (file.mimeType) {
    case 'application/vnd.google-apps.document': {
      const { text } = htmlToText(await exportText(client, id, 'text/html'));
      return { title: name, parts: [{ text }] };
    }
    case 'application/vnd.google-apps.spreadsheet':
      return { title: name, parts: [{ text: await exportText(client, id, 'text/csv') }] };
    case 'application/pdf':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'text/markdown':
    case 'text/plain':
      return extractFile(await download(client, id), file.mimeType, name);
    default:
      return `type ${file.mimeType ?? 'unknown'} is not read`;
  }
};

export async function* loadDrive(
  selection: DriveSelection,
  connection: DriveConnection,
  { maxFiles }: { readonly maxFiles: number },
): AsyncGenerator<ConnectorEvent, void, undefined> {
  const client = driveFor(connection);
  const folders = selection.folderIds.map((id) => ({ id, depth: 0 }));
  const seen = new Set<string>();
  let files = 0;

  while (folders.length > 0) {
    const folder = folders.shift();
    if (folder === undefined || seen.has(folder.id)) {
      continue;
    }
    seen.add(folder.id);
    for await (const file of listChildren(client, folder.id)) {
      const id = file.id ?? '';
      if (file.mimeType === FOLDER) {
        if (folder.depth < MAX_FOLDER_DEPTH) {
          folders.push({ id, depth: folder.depth + 1 });
        }
        continue;
      }
      if (files >= maxFiles) {
        return;
      }
      files += 1;
      try {
        const read = await readFile(client, file);
        yield typeof read === 'string'
          ? { type: 'skipped', externalId: id, name: file.name ?? id, detail: read }
          : { type: 'document', externalId: id, url: file.webViewLink ?? null, document: read };
      } catch (error) {
        if (error instanceof ConnectorAuthError) {
          throw error;
        }
        yield {
          type: 'skipped',
          externalId: id,
          name: file.name ?? id,
          detail: error instanceof Error ? error.message : 'the file could not be read',
        };
      }
    }
  }
}

/** Folders the grant can see under `parentId` (or at the top), for the picker. */
export const browseDrive = async (
  connection: DriveConnection,
  parentId: string | undefined,
): Promise<ConnectorItem[]> => {
  const client = driveFor(connection);
  const parent = parentId === undefined ? '' : `'${parentId.replace(/['\\]/g, '')}' in parents and `;
  const { data } = await authAware(() =>
    client.files.list({
      q: `${parent}mimeType = '${FOLDER}' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 100,
    }),
  );
  return (data.files ?? []).map((file) => ({
    id: file.id ?? '',
    title: file.name ?? '',
    kind: 'folder' as const,
  }));
};

export const driveAuthorizeUrl = (app: OAuthApp, redirectUri: string, state: string): string => {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.href;
};

export const exchangeDriveCode = async (
  app: OAuthApp,
  { code, redirectUri }: { readonly code: string; readonly redirectUri: string },
  transport: Pick<DriveConnection, 'fetch' | 'tokenUrl'>,
): Promise<OAuthTokens> => {
  const { tokens } = await authAware(() => oauthClient(app, transport, redirectUri).getToken(code));
  if (typeof tokens.access_token !== 'string') {
    throw new ConnectorAuthError(DRIVE_SERVICE, 'the token response had no access token');
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expiry_date ?? null,
  };
};
