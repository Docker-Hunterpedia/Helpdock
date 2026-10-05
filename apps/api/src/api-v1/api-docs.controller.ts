import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/route-declaration.js';
import { buildInfo } from '../observability/build-info.js';
import { API_OPERATIONS, buildOpenApiDocument, type OpenApiDocument } from './openapi.js';

/**
 * `/api/docs` (M8-02, REQUIREMENTS §4.11): the OpenAPI 3.1 document of
 * `/api/v1`, as JSON for tools and as a plain page for people. Public: it
 * describes the routes and nothing of any brand's data, and an integrator
 * reads it before they hold a key.
 *
 * The page is rendered here, with no script and no third-party viewer — the
 * install's CSP forbids both, and the document is short enough to read as a
 * list. Its only content is the operations table below, escaped.
 */

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );

/** Nothing but the page itself: no script, no style sheet, no frame, no form. */
export const DOCS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const renderDocsPage = (document: OpenApiDocument): string => {
  const rows = API_OPERATIONS.map(
    (operation) =>
      `<tr><td><code>${operation.method.toUpperCase()}</code></td><td><code>${escapeHtml(operation.path)}</code></td><td>${escapeHtml(operation.summary)}</td><td><code>${operation.scope}</code></td></tr>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.info.title)} ${escapeHtml(document.info.version)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:0 auto;padding:1rem;line-height:1.5}table{border-collapse:collapse;width:100%}th,td{text-align:start;padding:.5rem;border-block-end:1px solid;vertical-align:top}</style>
</head>
<body>
<main>
<h1>${escapeHtml(document.info.title)} <small>${escapeHtml(document.info.version)}</small></h1>
<p>Authenticate with <code>Authorization: Bearer hd_live_…</code>. Send an <code>Idempotency-Key</code> header to make a POST safe to retry. The machine-readable document is <a href="/api/docs/openapi.json">openapi.json</a> (OpenAPI 3.1).</p>
<table>
<thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">What it does</th><th scope="col">Scope</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</main>
</body>
</html>`;
};

@Controller('api/docs')
export class ApiDocsController {
  readonly #document = buildOpenApiDocument(buildInfo().version);
  readonly #page = renderDocsPage(this.#document);

  @Get()
  @Public()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', DOCS_PAGE_CSP)
  page(): string {
    return this.#page;
  }

  @Get('openapi.json')
  @Public()
  document(): OpenApiDocument {
    return this.#document;
  }
}
