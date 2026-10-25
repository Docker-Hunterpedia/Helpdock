import type { APIRoute } from 'astro';
import { SITE_URL } from '../data/site.ts';
import { robotsTxt } from '../lib/robots.ts';

export const GET: APIRoute = () =>
  new Response(robotsTxt(SITE_URL), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
