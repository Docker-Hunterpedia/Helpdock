/**
 * The guides in the shapes AI tools and offline readers take: the docs zip,
 * llms.txt (llmstxt.org) and llms-full.txt. Every link in a guide is already
 * absolute (see rewriteMarkdownLinks), so each file reads correctly on its own.
 */
import type { ZipEntry } from './zip.ts';

export type Guide = { id: string; title: string; description: string; markdown: string };

export const markdownUrl = (siteUrl: string, id: string) => `${siteUrl}/docs/${id}.md`;
export const pageUrl = (siteUrl: string, id: string) => `${siteUrl}/docs/${id}/`;

const SUMMARY =
  'Helpdock is an open-source (AGPL-3.0), self-hosted customer support platform: ticketing, a help center, a live chat widget and AI that answers only from your knowledge, with one Docker Compose deploy serving many brands, in English and Arabic.';

const byTitle = (guides: Guide[]) => [...guides].sort((a, b) => a.title.localeCompare(b.title));

export function docsZipEntries(input: {
  version: string;
  siteUrl: string;
  guides: Guide[];
}): ZipEntry[] {
  const folder = `helpdock-docs-${input.version}`;
  const index = [
    `# Helpdock ${input.version} documentation`,
    '',
    SUMMARY,
    '',
    `These are the guides published with Helpdock ${input.version} at ${input.siteUrl}/docs/.`,
    '',
    ...byTitle(input.guides).map(
      (guide) => `- [${guide.title}](${guide.id}.md): ${guide.description}`,
    ),
    '',
  ].join('\n');
  return [
    { path: `${folder}/README.md`, content: index },
    ...input.guides.map((guide) => ({ path: `${folder}/${guide.id}.md`, content: guide.markdown })),
  ];
}

export function llmsTxt(input: { version: string; siteUrl: string; guides: Guide[] }): string {
  return [
    '# Helpdock',
    '',
    `> ${SUMMARY} These links document release ${input.version}.`,
    '',
    'Each guide is plain Markdown. The REST API reference of a running install is at `<APP_URL>/api/docs`.',
    '',
    '## Docs',
    '',
    ...byTitle(input.guides).map(
      (guide) =>
        `- [${guide.title}](${markdownUrl(input.siteUrl, guide.id)}): ${guide.description}`,
    ),
    '',
    '## Optional',
    '',
    `- [Every guide in one file](${input.siteUrl}/llms-full.txt)`,
    `- [Changelog](${input.siteUrl}/changelog/)`,
    `- [Source code](https://github.com/Docker-Hunterpedia/Helpdock)`,
    '',
  ].join('\n');
}

export function llmsFullTxt(input: { version: string; siteUrl: string; guides: Guide[] }): string {
  const header = `# Helpdock ${input.version} documentation\n\n> ${SUMMARY}`;
  const parts = byTitle(input.guides).map(
    (guide) => `Source: ${pageUrl(input.siteUrl, guide.id)}\n\n${guide.markdown.trim()}`,
  );
  return `${[header, ...parts].join('\n\n---\n\n')}\n`;
}
