import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNPUBLISHED } from '../data/docs.ts';
import { llmsTxt } from './bundles.ts';
import { skillFiles, TASKS } from './skill.ts';

const guide = (id: string) => ({
  id,
  title: id,
  description: `About ${id}.`,
  markdown: `# ${id}\n`,
});
const allTaskGuides = [...new Set(TASKS.map(([, id]) => id))].map(guide);
const files = skillFiles({
  version: '1.2.0',
  siteUrl: 'https://example.test',
  guides: allTaskGuides,
});
const skill = files.find((file) => file.path === 'SKILL.md')?.content as string;

describe('skillFiles', () => {
  it('opens with frontmatter an agent can load: a name and a quoted description', () => {
    const frontmatter = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
    expect(frontmatter?.[1]).toBe('helpdock');
    const description = JSON.parse(frontmatter?.[2] as string) as string;
    expect(description).toMatch(/^Use when installing/);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('stamps the release into the body and its commands', () => {
    expect(skill).toContain('# Helpdock 1.2.0');
    expect(skill).toContain('--branch v1.2.0');
    expect(skill).toContain('HELPDOCK_VERSION=1.2.0');
  });

  it('ships every reference its task map links to', () => {
    const paths = new Set(files.map((file) => file.path));
    const linked = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]);
    expect(linked.length).toBe(TASKS.length);
    for (const path of linked) expect(paths).toContain(path);
  });

  it('keeps the body short enough to load whole', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('fails the build when a guide its task map names is not published', () => {
    expect(() =>
      skillFiles({ version: '1.2.0', siteUrl: 'https://example.test', guides: [guide('install')] }),
    ).toThrow(/not published: .*deploy/);
  });

  it('names only guides that exist in docs/guides', () => {
    const published = readdirSync(new URL('../../../docs/guides/', import.meta.url))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .filter((name) => !UNPUBLISHED.has(name));
    for (const [, id] of TASKS) expect(published).toContain(id);
  });
});

describe('llmsTxt', () => {
  it('follows llmstxt.org: a title, a quoted summary, then sections of links', () => {
    const text = llmsTxt({
      version: '1.2.0',
      siteUrl: 'https://example.test',
      guides: [guide('api')],
    });
    expect(text).toMatch(/^# Helpdock\n\n> .+release 1\.2\.0\.\n/);
    expect(text).toContain('## Docs\n\n- [api](https://example.test/docs/api.md): About api.');
  });
});
