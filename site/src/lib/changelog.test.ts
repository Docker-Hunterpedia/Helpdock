import { describe, expect, it } from 'vitest';
import {
  boldLead,
  mergeReleases,
  parseTagDates,
  splitSections,
  tidyChangesetBody,
} from './changelog.ts';

const notes = `# Changelog

Intro text that is not a release.

## 1.0.0 — 2026-10-20

The first stable release.

## 0.5.1 — 2026-10-13

A fix release.
`;

const changes = `# @helpdock/api

## 1.2.0

### Minor Changes

- [#367](https://github.com/o/r/pull/367) [\`b1cefab\`](https://github.com/o/r/commit/b1cefab) Thanks [@someone](https://github.com/someone)! - Snooze a ticket.
  A second line.

## 1.0.0

### Major Changes

- Helpdock 1.0.0.
`;

describe('splitSections', () => {
  it('reads each release heading with or without a date and drops the preamble', () => {
    expect(splitSections(notes)).toEqual([
      { version: '1.0.0', date: '2026-10-20', body: 'The first stable release.' },
      { version: '0.5.1', date: '2026-10-13', body: 'A fix release.' },
    ]);
    expect(splitSections(changes).map((section) => section.version)).toEqual(['1.2.0', '1.0.0']);
  });
});

describe('tidyChangesetBody', () => {
  it('ends each entry with its pull request instead of the commit and thanks', () => {
    expect(
      tidyChangesetBody(
        '### Minor Changes\n\n- [#367](https://github.com/o/r/pull/367) [`b1cefab`](https://github.com/o/r/commit/b1cefab) Thanks [@someone](https://github.com/someone)! - Snooze a ticket.\n  A second line.',
      ),
    ).toBe(
      '### Minor changes\n\n- Snooze a ticket. ([#367](https://github.com/o/r/pull/367))\n  A second line.',
    );
  });
});

describe('boldLead', () => {
  it('turns a name before the first colon into the bold lead', () => {
    expect(boldLead('Command palette (M14-05): `Ctrl`+`K` opens a dialog.')).toBe(
      '**Command palette (M14-05).** `Ctrl`+`K` opens a dialog.',
    );
  });

  it.each([
    ['a sentence that ends before any colon', 'Snooze a ticket. Wake paths: time and reply.'],
    ['a colon inside a code span', 'Set `HD_X: 1` to keep it.'],
    [
      'an entry that already has a lead',
      '**Clearer copy.** The caption counts people: all of them.',
    ],
    ['no colon at all', 'Inbox empty states name why a view is empty.'],
  ])('leaves %s alone', (_case, text) => {
    expect(boldLead(text)).toBe(text);
  });
});

describe('mergeReleases', () => {
  const tagDates = new Map([
    ['1.2.0', '2026-10-24'],
    ['1.1.1', '2026-10-21'],
    ['1.0.0', '2026-10-19'],
  ]);

  it('prefers the hand-written notes, then the Changesets list, then the tag alone', () => {
    const releases = mergeReleases({ notes, changes, tagDates, current: '1.2.0' });
    expect(releases.map((release) => [release.version, release.source, release.date])).toEqual([
      ['1.2.0', 'changes', '2026-10-24'],
      ['1.1.1', 'tag', '2026-10-21'],
      ['1.0.0', 'notes', '2026-10-20'],
      ['0.5.1', 'notes', '2026-10-13'],
    ]);
  });

  it('leaves out releases newer than the one the site shows', () => {
    const releases = mergeReleases({ notes, changes, tagDates, current: '1.1.1' });
    expect(releases.map((release) => release.version)).toEqual(['1.1.1', '1.0.0', '0.5.1']);
  });
});

describe('parseTagDates', () => {
  it('keeps plain release tags only', () => {
    expect(
      parseTagDates('v1.2.0 2026-10-24\nv1.3.0-rc.1 2026-10-25\nnot-a-tag 2026-01-01\n'),
    ).toEqual(new Map([['1.2.0', '2026-10-24']]));
  });
});
