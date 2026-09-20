import { TICKET_VIEWING_TTL_MS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { forgetStale, noteViewing, viewersOf } from './collision.js';

const ME = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
const YARA = '0192c3f0-1a2b-7c3d-8e4f-00000000000c';
const NOW = 1_000_000;

describe('noteViewing', () => {
  it('records when somebody was last heard from', () => {
    expect(noteViewing({}, OMAR, NOW)).toEqual({ [OMAR]: NOW });
  });

  it('moves the sighting forward rather than adding a second one', () => {
    expect(noteViewing({ [OMAR]: NOW - 5_000 }, OMAR, NOW)).toEqual({ [OMAR]: NOW });
  });
});

describe('viewersOf', () => {
  it('names the people still looking, newest first', () => {
    const sightings = { [OMAR]: NOW - 10_000, [YARA]: NOW - 1_000 };

    expect(viewersOf(sightings, ME, NOW)).toEqual([YARA, OMAR]);
  });

  it('never names the person reading, even signed in twice', () => {
    expect(viewersOf({ [ME]: NOW }, ME, NOW)).toEqual([]);
  });

  it('drops a name nobody has repeated inside the window', () => {
    const sightings = { [OMAR]: NOW - TICKET_VIEWING_TTL_MS };

    expect(viewersOf(sightings, ME, NOW)).toEqual([]);
  });

  it('keeps a name repeated a moment before the window closed', () => {
    const sightings = { [OMAR]: NOW - TICKET_VIEWING_TTL_MS + 1 };

    expect(viewersOf(sightings, ME, NOW)).toEqual([OMAR]);
  });
});

describe('forgetStale', () => {
  it('removes what has gone quiet', () => {
    const sightings = { [OMAR]: NOW - TICKET_VIEWING_TTL_MS - 1, [YARA]: NOW };

    expect(forgetStale(sightings, NOW)).toEqual({ [YARA]: NOW });
  });

  it('hands back the same object when nothing has gone quiet', () => {
    const sightings = { [YARA]: NOW };

    expect(forgetStale(sightings, NOW)).toBe(sightings);
  });
});
