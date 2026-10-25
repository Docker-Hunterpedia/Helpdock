import type { APIRoute, GetStaticPaths } from 'astro';
import { guideDocs } from '../../lib/downloads.ts';

/** Each guide's Markdown, links absolute, for "View as Markdown" and AI tools. */
export const getStaticPaths = (async () =>
  (await guideDocs()).map((guide) => ({
    params: { slug: guide.id },
    props: { markdown: guide.markdown },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.markdown as string, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
