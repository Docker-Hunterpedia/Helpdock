import { describe, expect, it } from 'vitest';
import {
  groupKind,
  groupLabel,
  isFolded,
  parseItem,
  parseNotes,
  releaseAnchor,
  releaseStep,
} from './release-notes.ts';

const pull = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`;

const section = `The first stable release. Every milestone has shipped.

A second intro paragraph.

### New since 0.7

- **Previous tickets on the contact card.** The details panel lists up to
  three of the contact's other tickets (${pull(239)}).
- An item without a lead (${pull(1)}, ${pull(2)}).

### Upgrading from 0.7

Nothing to change in your configuration.

### Known limits

- **SSO was not run against live accounts.** Only stand-ins.

### Security

- A heading the timeline has no icon for.
`;

describe('parseNotes', () => {
  const notes = parseNotes(section);

  it('keeps the paragraphs before the first group as the intro', () => {
    expect(notes.intro).toEqual([
      'The first stable release. Every milestone has shipped.',
      'A second intro paragraph.',
    ]);
  });

  it('reads each ### heading as a group of the right kind', () => {
    expect(notes.groups.map((group) => [group.heading, group.kind])).toEqual([
      ['New since 0.7', 'new'],
      ['Upgrading from 0.7', 'upgrade'],
      ['Known limits', 'limits'],
      ['Security', 'other'],
    ]);
  });

  it('joins an item’s continuation lines and keeps a group’s plain paragraphs apart', () => {
    const [newGroup, upgrade] = notes.groups;
    expect(newGroup?.items[0]?.body).toBe(
      "The details panel lists up to\nthree of the contact's other tickets.",
    );
    expect(upgrade?.items).toEqual([]);
    expect(upgrade?.paragraphs).toEqual(['Nothing to change in your configuration.']);
  });
});

describe('parseItem', () => {
  it('makes the bold opening sentence the title', () => {
    expect(parseItem('**Snooze.** Wake a ticket later.')).toEqual({
      lead: 'Snooze.',
      body: 'Wake a ticket later.',
      pullRequests: [],
    });
  });

  it('keeps bold words that run on into their sentence in the text', () => {
    const text = '**"AI answered" on the ticket list** appears only once it has answered.';
    expect(parseItem(text)).toEqual({ body: text, pullRequests: [] });
  });

  it('turns closing pull request links into chips and keeps the full stop', () => {
    expect(parseItem(`They reach the api (${pull(175)}).`)).toEqual({
      body: 'They reach the api.',
      pullRequests: [{ number: '175', url: 'https://github.com/o/r/pull/175' }],
    });
  });

  it('finds the links at the end of the first paragraph of a longer item', () => {
    const item = parseItem(`Break-glass sign-in (${pull(379)})\n\nUpgrade note: re-register.`);
    expect(item.body).toBe('Break-glass sign-in\n\nUpgrade note: re-register.');
    expect(item.pullRequests.map((pr) => pr.number)).toEqual(['379']);
  });

  it('leaves a pull request named mid-sentence and an issue link in the text', () => {
    const text = `Released in ${pull(215)} after review ([#399](https://github.com/o/r/issues/399)).`;
    expect(parseItem(text)).toEqual({ body: text, pullRequests: [] });
  });
});

describe('group helpers', () => {
  it.each([
    ['M10 Meta channels', 'milestone'],
    ['Minor changes', 'new'],
    ['Patch Changes', 'fixes'],
    ['Gaps closed from M6 and M7', 'fixes'],
    ['Upgrade notes', 'upgrade'],
    ['Known gaps', 'limits'],
    ['Not in this release', 'limits'],
    ['Before the release', 'checks'],
    ['Anything else', 'other'],
  ] as const)('files "%s" as %s', (heading, kind) => {
    expect(groupKind(heading)).toBe(kind);
  });

  it('names the Changesets groups the way the notes do', () => {
    expect(groupLabel('Minor changes')).toBe('New');
    expect(groupLabel('Patch changes')).toBe('Fixes');
    expect(groupLabel('M9 Hardening')).toBe('M9 Hardening');
  });

  it('folds only the long, low-priority groups', () => {
    expect(['limits', 'checks', 'new', 'fixes'].map((kind) => isFolded(kind as never))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('releaseStep', () => {
  it.each([
    ['1.0.0', '0.7.0', 'major'],
    ['1.2.0', '1.1.1', 'minor'],
    ['1.1.1', '1.1.0', 'patch'],
    ['0.1.0', undefined, 'minor'],
  ] as const)('calls %s after %s a %s release', (version, previous, step) => {
    expect(releaseStep(version, previous)).toBe(step);
  });

  it('anchors a release by its dashed version', () => {
    expect(releaseAnchor('1.0.0')).toBe('v1-0-0');
  });
});
