import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Controller, Get, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/route-declaration.js';
import { ADMIN_DIST } from '../runtime/tokens.js';
import { cacheControlFor, INDEX_FILE, isApiPath, resolveAssetPath } from './admin-assets.js';
import { adminContentSecurityPolicy } from './content-security-policy.js';
import { InstallInfoService } from './install-info.service.js';
import { rewriteInstallMeta } from './install-meta.js';

/**
 * The admin SPA on the admin host (ARCHITECTURE §3). One catch-all route: a
 * request for a file in the build gets that file, everything else gets
 * `index.html` so the client router can take over. `/api/*` is excluded, because
 * a missing endpoint is a 404 and not a page.
 *
 * Fastify's router prefers a static route to a wildcard, so `/health`, `/ready`
 * and every declared `/api/…` route still win over this one.
 */
@Controller()
export class AdminSpaController {
  readonly #root: string | undefined;
  readonly #installInfo: InstallInfoService;
  /** The build never changes while the process runs, so the file is read once. */
  #index: string | undefined;
  /** Derived from that file, because it carries the hash of its inline script. */
  #policy: string | undefined;

  constructor(
    @Inject(ADMIN_DIST) root: string | undefined,
    @Inject(InstallInfoService) installInfo: InstallInfoService,
  ) {
    this.#root = root;
    this.#installInfo = installInfo;
  }

  // Fastify 5's router takes `/*` and nothing else: `{*path}` and `*path` are
  // path-to-regexp spellings, which it refuses with "Wildcard must be the last
  // character in the route". Nest hands the path to Fastify unchanged.
  @Get('*')
  @Public()
  async serve(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const root = this.#root;
    if (root === undefined) {
      throw new NotFoundException('This process serves no admin build (ADMIN_DIST_DIR)');
    }

    const pathname = request.url.split('?')[0] ?? '/';
    if (isApiPath(pathname)) {
      throw new NotFoundException('Unknown endpoint');
    }

    const asset = resolveAssetPath(root, pathname);
    if (asset === undefined || asset === INDEX_FILE) {
      await this.#sendIndex(root, reply);
      return;
    }

    await reply
      .header('cache-control', cacheControlFor(asset))
      .sendFile(asset, root, { cacheControl: false });
  }

  async #sendIndex(root: string, reply: FastifyReply): Promise<void> {
    // Two requests racing here both read the file, which costs one extra read
    // and never a wrong answer. Caching the promise instead would cache a
    // rejection for the life of the process.
    this.#index ??= await readFile(path.join(root, INDEX_FILE), 'utf8');
    this.#policy ??= adminContentSecurityPolicy(this.#index);

    const html = rewriteInstallMeta(this.#index, await this.#installInfo.read());
    await reply
      .header('cache-control', cacheControlFor(INDEX_FILE))
      // Replaces the `default-src 'none'` every api response carries, which is
      // right for JSON and would keep this page from loading anything at all.
      .header('content-security-policy', this.#policy)
      .type('text/html; charset=utf-8')
      .send(html);
  }
}
