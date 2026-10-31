import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { soundUrl } from './player.js';

/** The bundled files M14-25 plays: real, small, and named in the guide that gives their licence. */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const EVENTS = ['waitingChat', 'newConversation', 'customerReply', 'assignedOrMentioned'] as const;
const MAX_BYTES = 25_000;

describe('the notification sound files', () => {
  it.each(EVENTS)('has a small, valid 16-bit mono WAV for %s', (event) => {
    const file = soundUrl(event, '/').replace(/^\//, '');
    const bytes = readFileSync(join(ROOT, 'public', file));

    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(bytes.length).toBeLessThan(MAX_BYTES);
    // Not silence: the generator wrote a tone.
    expect(bytes.subarray(44).some((byte) => byte !== 0)).toBe(true);
  });

  it('are all listed, with their licence, in the notifications guide', () => {
    const guide = readFileSync(
      join(ROOT, '..', '..', 'docs', 'guides', 'notifications.md'),
      'utf8',
    );

    expect(guide).toContain('CC0 1.0');
    for (const event of EVENTS) {
      expect(guide).toContain(soundUrl(event, '/').split('/').pop());
    }
  });
});
