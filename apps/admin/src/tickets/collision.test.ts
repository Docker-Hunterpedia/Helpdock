import { TICKET_VIEWING_TTL_MS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { forgetStale, noteViewing, viewersOf } from './collision.js';

const ME = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
const YARA = '0192c3f0-1a2b-7c3d-8e4f-00000000000c';
const NOW = 1_000_000;

const seen = (at: number, activity: 'viewing' | 'replying' = 'viewing') => ({ at, activity });

describe('noteViewing', () => {
  it('records when somebody was last heard from, and what they were doing', () => {
    expect(noteViewing({}, OMAR, 'viewing', NOW)).toEqual({ [OMAR]: seen(NOW) });
  });

  it('moves the sighting forward rather than adding a second one', () => {
    expect(noteViewing({ [OMAR]: seen(NOW - 5_000) }, OMAR, 'viewing', NOW)).toEqual({
      [OMAR]: seen(NOW),
    });
  });

  it('turns a viewer into a replier, and back, on their next word (M1-09)', () => {
    const replying = noteViewing({ [OMAR]: seen(NOW - 5_000) }, OMAR, 'replying', NOW);
    expect(replying[OMAR]?.activity).toBe('replying');

    expect(noteViewing(replying, OMAR, 'viewing', NOW + 1)[OMAR]?.activity).toBe('viewing');
  });
});

describe('viewersOf', () => {
  it('names the people still looking, newest first', () => {
    const sightings = { [OMAR]: seen(NOW - 10_000), [YARA]: seen(NOW - 1_000) };

    expect(viewersOf(sightings, ME, NOW).map((viewer) => viewer.userId)).toEqual([YARA, OMAR]);
  });

  it('puts whoever is replying first, however long ago they said so (M1-09)', () => {
    const sightings = { [OMAR]: seen(NOW - 10_000, 'replying'), [YARA]: seen(NOW - 1_000) };

    expect(viewersOf(sightings, ME, NOW)).toEqual([
      { userId: OMAR, activity: 'replying' },
      { userId: YARA, activity: 'viewing' },
    ]);
  });

  it('never names the person reading, even signed in twice', () => {
    expect(viewersOf({ [ME]: seen(NOW) }, ME, NOW)).toEqual([]);
  });

  it('drops a name nobody has repeated inside the window, replying or not', () => {
    const sightings = { [OMAR]: seen(NOW - TICKET_VIEWING_TTL_MS, 'replying') };

    expect(viewersOf(sightings, ME, NOW)).toEqual([]);
  });

  it('keeps a name repeated a moment before the window closed', () => {
    const sightings = { [OMAR]: seen(NOW - TICKET_VIEWING_TTL_MS + 1) };

    expect(viewersOf(sightings, ME, NOW).map((viewer) => viewer.userId)).toEqual([OMAR]);
  });
});

describe('forgetStale', () => {
  it('removes what has gone quiet', () => {
    const sightings = { [OMAR]: seen(NOW - TICKET_VIEWING_TTL_MS - 1), [YARA]: seen(NOW) };

    expect(forgetStale(sightings, NOW)).toEqual({ [YARA]: seen(NOW) });
  });

  it('hands back the same object when nothing has gone quiet', () => {
    const sightings = { [YARA]: seen(NOW) };

    expect(forgetStale(sightings, NOW)).toBe(sightings);
  });
});
