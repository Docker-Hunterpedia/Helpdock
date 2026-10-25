import { getCollection } from 'astro:content';
import { SITE_URL, VERSION } from '../data/site.ts';
import { docsZipEntries, type Guide } from './bundles.ts';
import { SKILL_NAME, skillFiles } from './skill.ts';
import { createZip } from './zip.ts';

export async function guideDocs(): Promise<Guide[]> {
  const guides = await getCollection('guides');
  return guides
    .map((guide) => ({
      id: guide.id,
      title: guide.data.title,
      description: guide.data.description,
      markdown: guide.data.markdown,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The files under /downloads/, each built once per build and shared by the pages that size them. */
let built: Promise<Map<string, Uint8Array>> | undefined;

export function downloads(): Promise<Map<string, Uint8Array>> {
  built ??= (async () => {
    const input = { version: VERSION, siteUrl: SITE_URL, guides: await guideDocs() };
    const docs = createZip(docsZipEntries(input));
    const skill = createZip(
      skillFiles(input).map((file) => ({ ...file, path: `${SKILL_NAME}/${file.path}` })),
    );
    return new Map([
      [`helpdock-docs-${VERSION}.zip`, docs],
      ['helpdock-docs-latest.zip', docs],
      [`helpdock-skill-${VERSION}.zip`, skill],
      ['helpdock-skill-latest.zip', skill],
    ]);
  })();
  return built;
}

/** "84 KB": the size a download card shows. */
export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
