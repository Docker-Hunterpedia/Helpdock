import type { APIRoute } from 'astro';
import { SITE_URL, VERSION } from '../data/site.ts';
import { llmsTxt } from '../lib/bundles.ts';
import { guideDocs } from '../lib/downloads.ts';

export const GET: APIRoute = async () =>
  new Response(llmsTxt({ version: VERSION, siteUrl: SITE_URL, guides: await guideDocs() }), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
