import { compareReleasesDescending, isPlainRelease } from './version.ts';

export type Release = {
  version: string;
  /** `YYYY-MM-DD`, from the changelog heading or the release tag. */
  date?: string;
  /** Markdown of the release's section. Empty when only the tag records it. */
  body: string;
  /** `notes` is the hand-written CHANGELOG.md section; `changes` the Changesets list. */
  source: 'notes' | 'changes' | 'tag';
};

type Section = { version: string; date?: string; body: string };

const HEADING = /^## (\d+\.\d+\.\d+)(?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

/** Splits a changelog into its `## x.y.z` sections. Text before the first is dropped. */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  const lines: string[] = [];
  const close = () => {
    if (current) sections.push({ ...current, body: lines.join('\n').trim() });
    lines.length = 0;
  };
  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { version: heading[1] as string, ...(heading[2] ? { date: heading[2] } : {}) };
    } else if (current) {
      lines.push(line);
    }
  }
  close();
  return sections;
}

// `- [#380](…) [`66883b9`](…) Thanks [@name](…)! - Text` becomes `- Text ([#380](…))`.
const CHANGESET_ITEM =
  /^- \[(#\d+)\]\(([^)]+)\) \[`[0-9a-f]+`\]\([^)]+\) Thanks \[@[^\]]+\]\([^)]+\)! - (.*)$/;

/** Rewrites a Changesets entry list into plain items that end with their pull request. */
export function tidyChangesetBody(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      const item = CHANGESET_ITEM.exec(line);
      return item ? `- ${item[3]} ([${item[1]}](${item[2]}))` : line;
    })
    .join('\n')
    .replace(/^### (Major|Minor|Patch) Changes$/gm, (_all, kind: string) => `### ${kind} changes`);
}

/**
 * Every published release up to `current`, newest first. The hand-written
 * CHANGELOG.md section wins; a release without one uses the Changesets list;
 * a tag with neither still gets an entry that points at its GitHub Release.
 */
export function mergeReleases(input: {
  notes: string;
  changes: string;
  tagDates: ReadonlyMap<string, string>;
  current: string;
}): Release[] {
  const byVersion = new Map<string, Release>();
  for (const section of splitSections(input.changes)) {
    byVersion.set(section.version, {
      version: section.version,
      body: tidyChangesetBody(section.body),
      source: 'changes',
    });
  }
  for (const section of splitSections(input.notes)) {
    byVersion.set(section.version, { ...section, source: 'notes' });
  }
  for (const version of input.tagDates.keys()) {
    if (!byVersion.has(version)) byVersion.set(version, { version, body: '', source: 'tag' });
  }
  return [...byVersion.values()]
    .filter(
      (release) =>
        isPlainRelease(release.version) &&
        compareReleasesDescending(release.version, input.current) >= 0,
    )
    .map((release) => {
      const date = release.date ?? input.tagDates.get(release.version);
      return date ? { ...release, date } : release;
    })
    .sort((a, b) => compareReleasesDescending(a.version, b.version));
}

/** Reads `git for-each-ref` output (`v1.2.0 2026-10-24` per line) into version → date. */
export function parseTagDates(output: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^v(\d+\.\d+\.\d+) (\d{4}-\d{2}-\d{2})$/.exec(line.trim());
    if (match) dates.set(match[1] as string, match[2] as string);
  }
  return dates;
}
