/**
 * Turns one release's Markdown section into the parts the changelog timeline
 * draws: the intro, then each `###` group with its items. An item's bold
 * opening sentence becomes its title and its trailing pull request links
 * become chips. The parts stay Markdown; the loader renders them.
 */

export type PullRequest = { number: string; url: string };
export type NoteItem = { lead?: string; body: string; pullRequests: PullRequest[] };
export type GroupKind = 'new' | 'milestone' | 'fixes' | 'upgrade' | 'limits' | 'checks' | 'other';
export type NoteGroup = {
  heading: string;
  kind: GroupKind;
  items: NoteItem[];
  paragraphs: string[];
};
export type ParsedNotes = { intro: string[]; groups: NoteGroup[] };
export type ReleaseStep = 'major' | 'minor' | 'patch';

const GROUP_KINDS: [RegExp, GroupKind][] = [
  [/^M\d+\b/, 'milestone'],
  [/^(new\b|major changes|minor changes)/i, 'new'],
  [/^(fixes|patch changes|gaps closed)/i, 'fixes'],
  [/^upgrad/i, 'upgrade'],
  [/^(known (limits|gaps)|not in this release)/i, 'limits'],
  [/^before the release/i, 'checks'],
];

export function groupKind(heading: string): GroupKind {
  return GROUP_KINDS.find(([pattern]) => pattern.test(heading))?.[1] ?? 'other';
}

/** Changesets' "Minor changes" and "Patch changes" read as "New" and "Fixes". */
export function groupLabel(heading: string): string {
  if (/^(major|minor) changes$/i.test(heading)) return 'New';
  if (/^patch changes$/i.test(heading)) return 'Fixes';
  return heading;
}

/** Long, low-priority groups start folded. */
export function isFolded(kind: GroupKind): boolean {
  return kind === 'limits' || kind === 'checks';
}

// A whole bold sentence; bold words that run on into the sentence stay in it.
const LEAD = /^\*\*([^*]+?[.!?])\*\*\s*/;
const PULL_LINK = /\[#(\d+)\]\((https:\/\/github\.com\/[^)\s]+\/pull\/\d+)\)/g;
// "… again ([#175](…/pull/175))." or "([#1](…), [#2](…))" closing a paragraph of an item.
const CLOSING_PULLS =
  /\s*\(((?:\[#\d+\]\([^)\s]+\/pull\/\d+\)(?:,\s*)?)+)\)(\.?)(?=[ \t]*(?:\n|$))/g;

export function parseItem(text: string): NoteItem {
  const pullRequests: PullRequest[] = [];
  const body = text.trim().replace(CLOSING_PULLS, (_all, links: string, stop: string) => {
    for (const link of links.matchAll(PULL_LINK)) {
      pullRequests.push({ number: link[1] as string, url: link[2] as string });
    }
    return stop;
  });
  const lead = LEAD.exec(body);
  if (!lead) return { body, pullRequests };
  return { lead: lead[1] as string, body: body.slice(lead[0].length), pullRequests };
}

/** Splits a group's lines into list items and plain paragraphs. */
function readBlocks(lines: string[]): { items: string[]; paragraphs: string[] } {
  const items: string[] = [];
  const paragraphs: string[] = [];
  let item: string[] | undefined;
  let paragraph: string[] = [];
  const closeParagraph = () => {
    if (paragraph.length) paragraphs.push(paragraph.join('\n'));
    paragraph = [];
  };
  const closeItem = () => {
    if (item) items.push(item.join('\n').trim());
    item = undefined;
  };
  for (const line of lines) {
    if (line.startsWith('- ')) {
      closeItem();
      closeParagraph();
      item = [line.slice(2)];
    } else if (item && (line.startsWith('  ') || line.trim() === '')) {
      item.push(line.replace(/^ {2}/, ''));
    } else if (line.trim() === '') {
      closeParagraph();
    } else {
      closeItem();
      paragraph.push(line);
    }
  }
  closeItem();
  closeParagraph();
  return { items, paragraphs };
}

export function parseNotes(markdown: string): ParsedNotes {
  const intro: string[] = [];
  const groups: NoteGroup[] = [];
  let heading: string | undefined;
  let lines: string[] = [];
  const close = () => {
    if (heading === undefined) {
      intro.push(...readBlocks(lines).paragraphs);
    } else {
      const { items, paragraphs } = readBlocks(lines);
      groups.push({ heading, kind: groupKind(heading), items: items.map(parseItem), paragraphs });
    }
    lines = [];
  };
  for (const line of markdown.split('\n')) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) {
      close();
      heading = match[1] as string;
    } else {
      lines.push(line);
    }
  }
  close();
  return { intro, groups };
}

/** How far a release moved from the one before it. */
export function releaseStep(version: string, previous: string | undefined): ReleaseStep {
  const [major, minor] = version.split('.').map(Number);
  const [prevMajor, prevMinor] = (previous ?? '0.0.0').split('.').map(Number);
  if (major !== prevMajor) return 'major';
  if (minor !== prevMinor) return 'minor';
  return 'patch';
}

/** `1.2.0` → `v1-2-0`, the anchor of a release on the changelog. */
export function releaseAnchor(version: string): string {
  return `v${version.replaceAll('.', '-')}`;
}
