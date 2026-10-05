import { describe, expect, it } from 'vitest';
import { minimalPdf } from '../fixtures.js';
import { fakeService } from './fake-service.js';
import {
  browseDrive,
  DRIVE_SCOPE,
  driveAuthorizeUrl,
  exchangeDriveCode,
  loadDrive,
} from './gdrive.js';
import { ConnectorAuthError, type ConnectorEvent } from './types.js';

const ROOT = 'https://drive.fake/';
const TOKEN_URL = 'https://oauth.fake/token';
const app = { clientId: 'client', clientSecret: 'shh' };

const tokenRoute = {
  'POST /token': {
    status: 200,
    json: { access_token: 'ya29.access', expires_in: 3600, token_type: 'Bearer' },
  },
};

const collect = async (generator: AsyncGenerator<ConnectorEvent>) => {
  const events: ConnectorEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
};

const listing = (files: readonly Record<string, unknown>[]) => ({ status: 200, json: { files } });

describe('loadDrive', () => {
  const pdf = minimalPdf([['Refunds take five days.']]);
  const service = fakeService({
    ...tokenRoute,
    'GET /drive/v3/files': (request) => {
      const q = request.url.searchParams.get('q') ?? '';
      if (q.startsWith("'root-folder'")) {
        return listing([
          {
            id: 'doc1',
            name: 'Policies',
            mimeType: 'application/vnd.google-apps.document',
            webViewLink: 'https://docs.google.com/doc1',
          },
          { id: 'sub', name: 'Archive', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'img', name: 'logo.png', mimeType: 'image/png' },
          {
            id: 'big',
            name: 'huge.pdf',
            mimeType: 'application/pdf',
            size: String(30 * 1024 * 1024),
          },
        ]);
      }
      if (q.startsWith("'sub'")) {
        return listing([
          { id: 'sheet1', name: 'Prices', mimeType: 'application/vnd.google-apps.spreadsheet' },
          { id: 'pdf1', name: 'FAQ.pdf', mimeType: 'application/pdf', size: String(pdf.length) },
        ]);
      }
      return listing([]);
    },
    'GET /drive/v3/files/doc1/export': (request) =>
      request.url.searchParams.get('mimeType') === 'text/html'
        ? { status: 200, text: '<html><body><h1>Refunds</h1><p>Five days.</p></body></html>' }
        : { status: 400 },
    'GET /drive/v3/files/sheet1/export': { status: 200, text: 'plan,price\nPro,20' },
    'GET /drive/v3/files/pdf1': { status: 200, text: Buffer.from(pdf).toString('latin1') },
  });
  const connection = {
    app,
    refreshToken: '1//refresh',
    fetch: service.fetch,
    rootUrl: ROOT,
    tokenUrl: TOKEN_URL,
  };

  it('walks picked folders and their subfolders, reading Docs, Sheets and PDFs', async () => {
    const events = await collect(
      loadDrive({ folderIds: ['root-folder'] }, connection, { maxFiles: 20 }),
    );

    expect(
      events.map((event) =>
        event.type === 'document'
          ? [event.externalId, event.document.title, event.document.parts[0]?.text.trim()]
          : [event.externalId, 'skipped', event.detail],
      ),
    ).toEqual([
      ['doc1', 'Policies', '# Refunds\n\nFive days.'],
      ['img', 'skipped', 'type image/png is not read'],
      ['big', 'skipped', 'larger than the 25 MB upload cap'],
      ['sheet1', 'Prices', 'plan,price\nPro,20'],
      ['pdf1', 'FAQ', expect.stringContaining('Refunds take five days.')],
    ]);
    const tokenRequest = service.requests.find((request) => request.url.href === TOKEN_URL);
    expect(tokenRequest?.body).toContain('refresh_token=1%2F%2Frefresh');
    const apiRequest = service.requests.find((request) => request.url.host === 'drive.fake');
    expect(apiRequest?.headers.authorization).toBe('Bearer ya29.access');
  });

  it('stops at the file limit', async () => {
    const events = await collect(
      loadDrive({ folderIds: ['root-folder'] }, connection, { maxFiles: 1 }),
    );

    expect(events.map((event) => event.externalId)).toEqual(['doc1']);
  });

  it('reports a revoked grant as an auth error', async () => {
    const revoked = fakeService({
      'POST /token': {
        status: 400,
        json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    });

    await expect(
      collect(
        loadDrive(
          { folderIds: ['root-folder'] },
          { ...connection, fetch: revoked.fetch },
          { maxFiles: 5 },
        ),
      ),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

describe('browseDrive', () => {
  it('lists folders under a parent for the picker', async () => {
    const service = fakeService({
      ...tokenRoute,
      'GET /drive/v3/files': listing([{ id: 'f1', name: 'Support' }]),
    });

    const folders = await browseDrive(
      { app, refreshToken: 'r', fetch: service.fetch, rootUrl: ROOT, tokenUrl: TOKEN_URL },
      'parent-1',
    );

    expect(folders).toEqual([{ id: 'f1', title: 'Support', kind: 'folder' }]);
    const list = service.requests.find((request) => request.url.pathname === '/drive/v3/files');
    expect(list?.url.searchParams.get('q')).toBe(
      "'parent-1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    );
  });
});

describe('Google OAuth', () => {
  it('asks for offline, read-only Drive access', () => {
    const url = new URL(driveAuthorizeUrl(app, 'https://support.test/cb', 'state-1'));

    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('exchanges a code for a refresh token', async () => {
    const service = fakeService({
      'POST /token': {
        status: 200,
        json: {
          access_token: 'ya29.a',
          refresh_token: '1//r',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
    });

    const tokens = await exchangeDriveCode(
      app,
      { code: 'code-1', redirectUri: 'https://support.test/cb' },
      { fetch: service.fetch, tokenUrl: TOKEN_URL },
    );

    expect(tokens).toMatchObject({ accessToken: 'ya29.a', refreshToken: '1//r' });
    expect(service.requests[0]?.body).toContain('code=code-1');
  });
});
