import type { APIRoute, GetStaticPaths } from 'astro';
import { downloads } from '../../lib/downloads.ts';

export const getStaticPaths = (async () =>
  [...(await downloads()).keys()].map((file) => ({ params: { file } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
  const bytes = (await downloads()).get(params.file as string) as Uint8Array;
  return new Response(bytes, { headers: { 'Content-Type': 'application/zip' } });
};
