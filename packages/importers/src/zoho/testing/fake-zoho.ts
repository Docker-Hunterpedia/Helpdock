import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VendorRequestGates } from '../../testing/request-gate.js';
import type { VendorAnswer, VendorFailure } from '../../testing/vendor-server.js';

type Organization = { id: string; companyName: string };
type DatedRecord = {
  id: string;
  createdTime: string;
  modifiedTime: string;
  [key: string]: unknown;
};
type Feedback = {
  id: string;
  ticketId: string;
  threadId: string;
  rating: string;
  ratedTime: string;
  customerRatedTime?: string;
  [key: string]: unknown;
};
type KnowledgeRow = {
  id: string;
  status: string;
  isTrashed: boolean | string;
  order: string;
  [key: string]: unknown;
};
type ArticleRow = {
  id: string;
  rootCategoryId: string;
  categoryId: string;
  translationId: string;
  locale: string;
  sourceLocale: string;
  currentVersion: string;
  latestVersion: string;
  status: string;
  isTrashed: boolean | string;
  modifiedTime: string;
  createdTime: string;
  answer: string;
  attachments: { resourceId: string; [key: string]: unknown }[];
  [key: string]: unknown;
};

/** Independent documented OAuth/Desk wire shapes. Only token refresh accepts POST. */
export class FakeZoho {
  readonly calls: {
    method: string;
    path: string;
    query: Record<string, string>;
    authenticated: boolean;
    orgId: string | undefined;
  }[] = [];
  private readonly server: Server;
  private readonly gates = new VendorRequestGates();
  private readonly failures: VendorFailure[] = [];
  private token = 'synthetic-zoho-access-0';
  private generation = 0;
  private readonly assets = new Map<string, { bytes: Buffer; contentType: string }>();
  tokenDomain = 'https://desk.zoho.com';
  tokenLifetime = 3600;
  articleOffsetOrigin: 0 | 1 = 1;
  articleAttachmentEnvelope: 'single' | 'data' = 'single';

  constructor(
    readonly fixture: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      orgId: string;
      organizations: Organization[];
      exportProfile?: {
        id: string;
        type: string;
        permissions: Record<string, Record<string, boolean>>;
      };
      tickets?: DatedRecord[];
      contacts?: DatedRecord[];
      accounts?: DatedRecord[];
      agents?: { id: string; status: string; [key: string]: unknown }[];
      departments?: { id: string; name: string; isEnabled: boolean }[];
      fields?: Partial<
        Record<
          'tickets' | 'contacts' | 'accounts',
          {
            id: string;
            apiName: string;
            displayLabel: string;
            type: string;
            isCustomField: boolean;
            [key: string]: unknown;
          }[]
        >
      >;
      tags?: Record<string, { name: string; id: number; tagType: string }[]>;
      threads?: Record<string, { id: string; createdTime: string; [key: string]: unknown }[]>;
      comments?: Record<string, { id: string; commentedTime: string; [key: string]: unknown }[]>;
      fullContent?: Record<string, { text: string; contentType: string }>;
      originalMail?: Record<
        string,
        {
          date: string;
          returnPath: string;
          subject: string;
          messageId: string;
          from: string;
          to: string;
          content: string;
        }
      >;
      feedback?: Feedback[];
      feedbackContent?: Record<string, string>;
      ticketAttachments?: Record<
        string,
        { id: string; createdTime: string; [key: string]: unknown }[]
      >;
      kbRoots?: KnowledgeRow[];
      kbSections?: KnowledgeRow[];
      recycledTaxonomy?: KnowledgeRow[];
      articles?: ArticleRow[];
      recycledArticles?: ArticleRow[];
    },
  ) {
    this.server = createServer((request, response) => {
      void this.respond(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  }

  get root(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Zoho stand-in is not listening');
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }
  async close(): Promise<void> {
    this.gates.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  failNext(failure: VendorFailure): void {
    this.failures.push(failure);
  }
  holdNextRequest(path: string) {
    return this.gates.hold(path);
  }
  expireToken(): void {
    this.token = `synthetic-expired-${++this.generation}`;
  }
  addAttachment(
    locator: {
      ticketId: string;
      kind: 'threads' | 'comments';
      messageId: string;
      attachmentId: string;
    },
    bytes: Buffer,
    contentType = 'application/pdf',
  ): string {
    const path = `/api/v1/tickets/${locator.ticketId}/${locator.kind}/${locator.messageId}/attachments/${locator.attachmentId}/content`;
    this.assets.set(path, { bytes: Buffer.from(bytes), contentType });
    return `${this.root}${path}`;
  }
  addTicketAttachment(
    ticketId: string,
    attachmentId: string,
    bytes: Buffer,
    contentType = 'application/pdf',
  ): string {
    const path = `/api/v1/tickets/${ticketId}/attachments/${attachmentId}/content`;
    this.assets.set(path, { bytes: Buffer.from(bytes), contentType });
    return `${this.root}${path}`;
  }

  addArticleAttachment(
    locator: { articleId: string; locale: string; resourceId: string },
    bytes: Buffer,
    contentType = 'application/pdf',
  ): string {
    const path = `/api/v1/articles/${locator.articleId}/translations/${encodeURIComponent(locator.locale)}/attachments/${locator.resourceId}/content`;
    this.assets.set(path, { bytes: Buffer.from(bytes), contentType });
    return `${this.root}${path}`;
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.root);
    await this.gates.wait(url.pathname);
    const method = request.method ?? '';
    const orgId = typeof request.headers.orgid === 'string' ? request.headers.orgid : undefined;
    this.calls.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authenticated: Boolean(request.headers.authorization),
      orgId,
    });
    const fail = this.failures.findIndex((entry) => entry.path === url.pathname);
    let answer: VendorAnswer;
    if (fail >= 0) answer = this.failures.splice(fail, 1)[0] ?? { status: 500 };
    else if (url.pathname === '/oauth/v2/token' && method === 'POST')
      answer = await this.refresh(request, url);
    else if (method !== 'GET') answer = { status: 405, json: { errorCode: 'METHOD_NOT_ALLOWED' } };
    else if (request.headers.authorization !== `Zoho-oauthtoken ${this.token}`)
      answer = { status: 401, json: { errorCode: 'INVALID_OAUTH' } };
    else if (orgId !== this.fixture.orgId)
      answer = { status: 403, json: { errorCode: 'OAUTH_ORG_MISMATCH' } };
    else answer = this.read(url);
    response.writeHead(answer.status, {
      'content-type': 'application/json',
      connection: 'close',
      ...answer.headers,
    });
    response.end(answer.bytes ?? JSON.stringify(answer.json ?? {}));
  }

  private async refresh(request: IncomingMessage, url: URL): Promise<VendorAnswer> {
    if (
      url.search ||
      request.headers.authorization ||
      request.headers.orgid ||
      !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
    )
      return { status: 400, json: { error: 'invalid_request' } };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) return { status: 400 };
      size += chunk.length;
      if (size > 65536) return { status: 413 };
      chunks.push(chunk);
    }
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (
      params.get('grant_type') !== 'refresh_token' ||
      params.get('client_id') !== this.fixture.clientId ||
      params.get('client_secret') !== this.fixture.clientSecret ||
      params.get('refresh_token') !== this.fixture.refreshToken
    )
      return { status: 200, json: { error: 'invalid_client' } };
    this.token = `synthetic-zoho-access-${++this.generation}`;
    return {
      status: 200,
      json: {
        access_token: this.token,
        token_type: 'Bearer',
        expires_in: this.tokenLifetime,
        api_domain: this.tokenDomain,
      },
    };
  }

  private articleRows(): ArticleRow[] {
    return [...(this.fixture.articles ?? []), ...(this.fixture.recycledArticles ?? [])];
  }

  private articleIndex(article: ArticleRow) {
    const { answer: _answer, attachments: _files, currentVersion: _version, ...native } = article;
    const translations = this.articleRows().filter(
      (row) => row.id === article.id && row.currentVersion === row.latestVersion,
    );
    return {
      ...native,
      availableLocaleTranslations: translations.map((row) => ({
        translationId: row.translationId,
        locale: row.locale,
        isTrashed: row.isTrashed,
        latestVersion: row.latestVersion,
      })),
    };
  }

  private read(url: URL): VendorAnswer {
    const headers = { 'X-Rate-Limit-Request-Weight-v3': '1', 'X-Rate-Limit-Remaining-v3': '999' };
    if (url.pathname === '/api/v1/myProfile')
      return this.fixture.exportProfile
        ? { status: 200, headers, json: this.fixture.exportProfile }
        : { status: 403, json: { errorCode: 'OAUTH_SCOPE_MISMATCH' } };
    if (url.pathname === '/api/v1/kbCategory/trashedCategories') {
      const from = Number(url.searchParams.get('from')),
        limit = Number(url.searchParams.get('limit'));
      if (
        !Number.isInteger(from) ||
        from < 1 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        url.searchParams.get('sortBy') !== 'deletedTime' ||
        [...url.searchParams.keys()].some((key) => !['from', 'limit', 'sortBy'].includes(key))
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = [...(this.fixture.recycledTaxonomy ?? [])].sort(
        (left, right) =>
          String(left.deletedTime).localeCompare(String(right.deletedTime)) ||
          left.id.localeCompare(right.id),
      );
      return {
        status: 200,
        headers,
        json: {
          data: rows.slice(from - 1, from - 1 + limit).map(({ isTrashed: _trash, ...row }) => row),
        },
      };
    }
    if (url.pathname === '/api/v1/articleTranslations/trashedTranslations') {
      const from = Number(url.searchParams.get('from')),
        limit = Number(url.searchParams.get('limit'));
      if (
        !Number.isInteger(from) ||
        from < 1 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        url.searchParams.get('sortBy') !== 'deletedTime' ||
        [...url.searchParams.keys()].some((key) => !['from', 'limit', 'sortBy'].includes(key))
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = this.articleRows()
        .filter(
          (row) => row.currentVersion === row.latestVersion && String(row.isTrashed) === 'true',
        )
        .sort(
          (left, right) =>
            String(left.deletedTime).localeCompare(String(right.deletedTime)) ||
            left.translationId.localeCompare(right.translationId),
        );
      return {
        status: 200,
        headers,
        json: {
          data: rows.slice(from - 1, from - 1 + limit).map((row) => {
            const { rootCategoryId: _root, ...native } = this.articleIndex(row);
            return {
              ...native,
              recycleBinEntityId: row.translationId,
              availableLocaleTranslations: native.availableLocaleTranslations.map(
                ({ latestVersion: _latest, ...hint }) => hint,
              ),
            };
          }),
        },
      };
    }
    const articleFiles =
      /^\/api\/v1\/articles\/([1-9]\d*)\/translations\/([A-Za-z0-9_-]+)\/attachments$/.exec(
        url.pathname,
      );
    if (articleFiles) {
      const from = Number(url.searchParams.get('from')),
        limit = Number(url.searchParams.get('limit'));
      if (
        !Number.isInteger(from) ||
        from < 1 ||
        limit !== 1 ||
        [...url.searchParams.keys()].some((key) => !['from', 'limit'].includes(key))
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const article = this.articleRows().find(
        (row) =>
          row.id === articleFiles[1] &&
          row.locale === articleFiles[2] &&
          row.currentVersion === row.latestVersion,
      );
      if (!article) return { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
      const file = article.attachments[from - 1];
      if (!file) return { status: 204 };
      const { size, ...native } = file;
      const row = { ...native, filesize: size };
      return {
        status: 200,
        headers,
        json: this.articleAttachmentEnvelope === 'single' ? row : { data: [row] },
      };
    }
    if (
      /^\/api\/v1\/articles\/[1-9]\d*\/translations\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9]+\/content$/.test(
        url.pathname,
      )
    ) {
      const file = this.assets.get(url.pathname);
      return file
        ? {
            status: 200,
            bytes: file.bytes,
            headers: { ...headers, 'content-type': file.contentType },
          }
        : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
    }
    const articleTranslationList = /^\/api\/v1\/articles\/([1-9]\d*)\/translations$/.exec(
      url.pathname,
    );
    if (url.pathname === '/api/v1/articles' || articleTranslationList) {
      const limit = Number(url.searchParams.get('limit'));
      const from = url.searchParams.has('from')
        ? Number(url.searchParams.get('from'))
        : this.articleOffsetOrigin;
      const status = url.searchParams.get('status');
      if (
        !Number.isInteger(from) ||
        from < this.articleOffsetOrigin ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        !['Draft', 'Published', 'Review', 'Expired', 'Unpublished'].includes(status ?? '') ||
        url.searchParams.get('sortBy') !== 'createdTime'
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = (this.fixture.articles ?? [])
        .filter(
          (row) =>
            row.currentVersion === row.latestVersion &&
            String(row.isTrashed) !== 'true' &&
            row.status === status &&
            (articleTranslationList
              ? row.id === articleTranslationList[1]
              : row.locale === row.sourceLocale),
        )
        .sort(
          (a, b) =>
            a.createdTime.localeCompare(b.createdTime) ||
            a.id.localeCompare(b.id) ||
            a.translationId.localeCompare(b.translationId),
        );
      return {
        status: 200,
        headers,
        json: {
          data: rows
            .slice(from - this.articleOffsetOrigin, from - this.articleOffsetOrigin + limit)
            .map((row) => this.articleIndex(row)),
        },
      };
    }
    const articleDetail =
      /^\/api\/v1\/articles\/([1-9]\d*)(?:\/translations\/([A-Za-z0-9_-]+))?(?:\/(answer|externalImages))?$/.exec(
        url.pathname,
      );
    if (articleDetail) {
      const row = this.articleRows().find(
        (entry) =>
          entry.id === articleDetail[1] &&
          entry.locale === (articleDetail[2] ?? entry.sourceLocale) &&
          entry.currentVersion === (url.searchParams.get('version') ?? entry.latestVersion),
      );
      if (!row) return { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
      if (articleDetail[3] === 'answer')
        return { status: 200, headers, json: { answer: row.answer } };
      if (articleDetail[3] === 'externalImages')
        return { status: 200, headers, json: { externalImageUrls: [] } };
      return { status: 200, headers, json: row };
    }
    const rootDetail = /^\/api\/v1\/kbRootCategories\/(\d+)$/.exec(url.pathname);
    const sectionDetail = /^\/api\/v1\/kbSections\/(\d+)$/.exec(url.pathname);
    if (rootDetail || sectionDetail) {
      const recycled = this.fixture.recycledTaxonomy ?? [];
      const roots = recycled.filter(
        (row) => row.rootCategoryId == null || row.rootCategoryId === row.id,
      );
      const rows = rootDetail
        ? [...(this.fixture.kbRoots ?? []), ...roots]
        : [...(this.fixture.kbSections ?? []), ...recycled.filter((row) => !roots.includes(row))];
      const id = rootDetail?.[1] ?? sectionDetail?.[1];
      const row = rows?.find((entry) => entry.id === id);
      return row
        ? { status: 200, headers, json: row }
        : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
    }
    const sectionList = /^\/api\/v1\/kbRootCategories\/(\d+)\/sections$/.exec(url.pathname);
    if (url.pathname === '/api/v1/kbRootCategories' || sectionList) {
      const from = Number(url.searchParams.get('from')),
        limit = Number(url.searchParams.get('limit'));
      const status = url.searchParams.get('status'),
        trashed = url.searchParams.get('isTrashed');
      if (
        !Number.isInteger(from) ||
        from < 1 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > (sectionList ? 50 : 700) ||
        url.searchParams.get('sortBy') !== 'order' ||
        !['true', 'false'].includes(trashed ?? '') ||
        !['SHOW_IN_HELPCENTER', 'HIDE_IN_HELPCENTER', 'DISABLED'].includes(status ?? '')
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = (sectionList ? (this.fixture.kbSections ?? []) : (this.fixture.kbRoots ?? []))
        .filter(
          (row) =>
            (!sectionList || row.rootCategoryId === sectionList[1]) &&
            row.status === status &&
            String(row.isTrashed) === trashed,
        )
        .sort((a, b) => Number(a.order) - Number(b.order) || a.id.localeCompare(b.id));
      // Thin list metadata deliberately omits translated names/descriptions.
      return {
        status: 200,
        headers,
        json: {
          data: rows
            .slice(from - 1, from - 1 + limit)
            .map((row) => ({ id: row.id, status: row.status, isTrashed: row.isTrashed })),
        },
      };
    }
    if (
      /^\/api\/v1\/tickets\/\d+\/(?:(?:threads|comments)\/\d+\/)?attachments\/\d+\/content$/.test(
        url.pathname,
      )
    ) {
      const asset = this.assets.get(url.pathname);
      return asset
        ? {
            status: 200,
            bytes: asset.bytes,
            headers: { ...headers, 'content-type': asset.contentType },
          }
        : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
    }
    if (url.pathname === '/api/v1/organizations')
      return { status: 200, headers, json: { data: this.fixture.organizations } };
    const ticketAttachments = /^\/api\/v1\/tickets\/(\d+)\/attachments$/.exec(url.pathname);
    if (ticketAttachments) {
      const from = Number(url.searchParams.get('from') ?? '0'),
        limit = Number(url.searchParams.get('limit') ?? '10');
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        url.searchParams.get('sortBy') !== 'createdTime' ||
        url.searchParams.get('include') !== 'creator' ||
        url.searchParams.has('isPublic')
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = [...(this.fixture.ticketAttachments?.[ticketAttachments[1] ?? ''] ?? [])].sort(
        (a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.id.localeCompare(b.id),
      );
      return { status: 200, headers, json: { data: rows.slice(from, from + limit) } };
    }
    const feedbackContent = /^\/api\/v1\/customerHappiness\/(\d+)\/content$/.exec(url.pathname);
    if (feedbackContent) {
      const content = this.fixture.feedbackContent?.[feedbackContent[1] ?? ''];
      return content === undefined
        ? { status: 404, json: { errorCode: 'URL_NOT_FOUND' } }
        : { status: 200, headers, json: { content } };
    }
    if (url.pathname === '/api/v1/customerHappiness') {
      const from = Number(url.searchParams.get('from') ?? '0'),
        limit = Number(url.searchParams.get('limit') ?? '10');
      const start = Number(url.searchParams.get('startTime')),
        end = Number(url.searchParams.get('endTime'));
      if (
        url.searchParams.get('department') !== 'allDepartment' ||
        url.searchParams.get('sortBy') !== 'ratedtime' ||
        !Number.isInteger(from) ||
        from < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start ||
        [...url.searchParams.keys()].some(
          (key) => !['department', 'sortBy', 'from', 'limit', 'startTime', 'endTime'].includes(key),
        )
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = [...(this.fixture.feedback ?? [])]
        .filter((row) => Date.parse(row.ratedTime) >= start && Date.parse(row.ratedTime) <= end)
        .sort(
          (a, b) => Date.parse(a.ratedTime) - Date.parse(b.ratedTime) || a.id.localeCompare(b.id),
        );
      return {
        status: 200,
        headers: { ...headers, 'X-Rate-Limit-Request-Weight-v3': '50' },
        json: { data: rows.slice(from, from + limit) },
      };
    }
    if (url.pathname === '/api/v1/fields') {
      const module = url.searchParams.get('module');
      if (
        !['tickets', 'contacts', 'accounts'].includes(module ?? '') ||
        [...url.searchParams.keys()].some((key) => key !== 'module')
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows =
        module === 'tickets'
          ? this.fixture.fields?.tickets
          : module === 'contacts'
            ? this.fixture.fields?.contacts
            : this.fixture.fields?.accounts;
      return { status: 200, headers, json: { data: rows ?? [] } };
    }
    const profile = /^\/api\/v1\/(contacts|accounts)(?:\/(\d+))?$/.exec(url.pathname);
    if (profile) {
      const rows =
        profile[1] === 'contacts' ? (this.fixture.contacts ?? []) : (this.fixture.accounts ?? []);
      if (profile[2]) {
        const row = rows.find((entry) => entry.id === profile[2]);
        return row
          ? { status: 200, headers, json: row }
          : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
      }
      const from = Number(url.searchParams.get('from') ?? '0'),
        limit = Number(url.searchParams.get('limit') ?? '10');
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        url.searchParams.get('sortBy') !== 'createdTime' ||
        url.searchParams.has('modifiedTimeRange')
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      return {
        status: 200,
        headers,
        json: {
          data: [...rows]
            .sort(
              (a, b) =>
                Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.id.localeCompare(b.id),
            )
            .slice(from, from + limit)
            .map(({ cf: _custom, description: _body, ...row }) => row),
        },
      };
    }
    if (url.pathname === '/api/v1/agents' || url.pathname === '/api/v1/departments') {
      const agents = url.pathname.endsWith('/agents');
      const from = Number(url.searchParams.get('from') ?? '0'),
        limit = Number(url.searchParams.get('limit') ?? '10');
      const status = url.searchParams.get('status') ?? 'ACTIVE',
        enabled = url.searchParams.get('isEnabled') ?? 'true';
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        (agents
          ? !['ACTIVE', 'DISABLED', 'DELETED', 'IMPORTED'].includes(status)
          : !['true', 'false'].includes(enabled))
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = agents
        ? (this.fixture.agents ?? []).filter((row) => row.status === status)
        : (this.fixture.departments ?? []).filter((row) => row.isEnabled === (enabled === 'true'));
      return {
        status: 200,
        headers,
        json: {
          data: [...rows].sort((a, b) => a.id.localeCompare(b.id)).slice(from, from + limit),
        },
      };
    }
    const original = /^\/api\/v1\/tickets\/(\d+)\/threads\/(\d+)\/originalContent$/.exec(
      url.pathname,
    );
    if (original) {
      const mail = this.fixture.originalMail?.[`${original[1]}:${original[2]}`];
      if (
        [...url.searchParams.keys()].some((key) => key !== 'inline') ||
        (url.searchParams.has('inline') &&
          !['true', 'false'].includes(url.searchParams.get('inline') ?? ''))
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      return mail
        ? { status: 200, headers, json: mail }
        : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
    }
    const full = /^\/api\/v1\/tickets\/(\d+)\/threads\/(\d+)\/fullContent$/.exec(url.pathname);
    if (full) {
      // The official API supplies fullContentURL but no envelope contract. Tests
      // distinguish MIME-identified text from unsupported JSON, never fabricate a JSON shape.
      const body = this.fixture.fullContent?.[`${full[1]}:${full[2]}`];
      return body
        ? {
            status: 200,
            bytes: Buffer.from(body.text),
            headers: { ...headers, 'content-type': body.contentType },
          }
        : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
    }
    const history = /^\/api\/v1\/tickets\/(\d+)\/(threads|comments)(?:\/(\d+))?$/.exec(
      url.pathname,
    );
    if (history) {
      const ticketId = history[1] ?? '',
        kind = history[2],
        id = history[3];
      const rows =
        kind === 'threads'
          ? (this.fixture.threads?.[ticketId] ?? [])
          : (this.fixture.comments?.[ticketId] ?? []);
      if (id) {
        const record = rows.find((row) => row.id === id);
        return record
          ? { status: 200, headers, json: record }
          : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
      }
      const from = Number(url.searchParams.get('from') ?? '0'),
        limit = Number(url.searchParams.get('limit') ?? '10');
      const sortBy =
        url.searchParams.get('sortBy') ?? (kind === 'threads' ? '-sendDateTime' : 'commentedTime');
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > (kind === 'threads' ? 200 : 100) ||
        !(
          kind === 'threads'
            ? ['sendDateTime', '-sendDateTime']
            : ['commentedTime', '-commentedTime']
        ).includes(sortBy)
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const sorted = [...rows].sort(
        (a, b) =>
          Date.parse(String(a.createdTime ?? a.commentedTime)) -
            Date.parse(String(b.createdTime ?? b.commentedTime)) || a.id.localeCompare(b.id),
      );
      if (sortBy.startsWith('-')) sorted.reverse();
      const page = sorted.slice(from, from + limit);
      return {
        status: 200,
        headers,
        json: {
          data:
            kind === 'comments'
              ? page
              : page.map((row) => ({
                  id: row.id,
                  createdTime: row.createdTime,
                  visibility: row.visibility,
                  direction: row.direction,
                  isDescriptionThread: row.isDescriptionThread,
                  status: row.status,
                })),
        },
      };
    }
    const tagTicketId = /^\/api\/v1\/tickets\/(\d+)\/tags$/.exec(url.pathname)?.[1];
    if (tagTicketId)
      return { status: 200, headers, json: { tags: this.fixture.tags?.[tagTicketId] ?? [] } };
    if (url.pathname === '/api/v1/tickets/archivedTickets') {
      const from = Number(url.searchParams.get('from') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const departmentId = url.searchParams.get('departmentId');
      if (
        !departmentId ||
        !/^\d+$/.test(departmentId) ||
        !Number.isInteger(from) ||
        from < 0 ||
        from > 4999 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        [...url.searchParams.keys()].some(
          (key) => !['from', 'limit', 'departmentId', 'viewType', 'include'].includes(key),
        )
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = (this.fixture.tickets ?? []).filter(
        (ticket) => ticket.isArchived === true && ticket.departmentId === departmentId,
      );
      return {
        status: 200,
        headers,
        json: {
          data: rows.slice(from, from + limit).map(({ modifiedTime: _modified, ...row }) => row),
        },
      };
    }
    const id = /^\/api\/v1\/tickets\/(\d+)$/.exec(url.pathname)?.[1];
    if (id) {
      const ticket = this.fixture.tickets?.find((entry) => entry.id === id);
      return ticket
        ? { status: 200, headers, json: ticket }
        : { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
    }
    if (['/api/v1/tickets', '/api/v1/tickets/search'].includes(url.pathname)) {
      const search = url.pathname.endsWith('/search');
      const from = Number(url.searchParams.get('from') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (search && from > 4999) ||
        !(search ? ['modifiedTime', '-modifiedTime'] : ['createdTime', '-createdTime']).includes(
          url.searchParams.get('sortBy') ?? 'createdTime',
        )
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const range = url.searchParams.get('modifiedTimeRange')?.split(',');
      if (
        search &&
        (!range || range.length !== 2 || range.some((time) => !Number.isFinite(Date.parse(time))))
      )
        return { status: 400, json: { errorCode: 'INVALID_DATA' } };
      const rows = [...(this.fixture.tickets ?? [])]
        .filter(
          (ticket) =>
            ticket.isArchived !== true &&
            (!search ||
              (Date.parse(ticket.modifiedTime) >= Date.parse(range?.[0] ?? '') &&
                Date.parse(ticket.modifiedTime) <= Date.parse(range?.[1] ?? ''))),
        )
        .sort(
          (a, b) =>
            Date.parse(search ? a.modifiedTime : a.createdTime) -
              Date.parse(search ? b.modifiedTime : b.createdTime) || a.id.localeCompare(b.id),
        );
      if (url.searchParams.get('sortBy')?.startsWith('-')) rows.reverse();
      return { status: 200, headers, json: { data: rows.slice(from, from + limit) } };
    }
    return { status: 404, json: { errorCode: 'URL_NOT_FOUND' } };
  }
}
