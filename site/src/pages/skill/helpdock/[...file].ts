import type { APIRoute, GetStaticPaths } from 'astro';
import { SITE_URL, VERSION } from '../../../data/site.ts';
import { guideDocs } from '../../../lib/downloads.ts';
import { skillFiles } from '../../../lib/skill.ts';

/** The skill's files unzipped: /skill/helpdock/SKILL.md and /skill/helpdock/references/<guide>.md. */
export const getStaticPaths = (async () =>
  skillFiles({ version: VERSION, siteUrl: SITE_URL, guides: await guideDocs() }).map((file) => ({
    params: { file: file.path },
    props: { content: file.content },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.content as string, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
