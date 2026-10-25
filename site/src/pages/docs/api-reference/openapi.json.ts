import type { APIRoute } from 'astro';
import document from '../../../generated/openapi.json';

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(document, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json' },
  });
