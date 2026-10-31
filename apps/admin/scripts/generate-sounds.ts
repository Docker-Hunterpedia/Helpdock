/**
 * Writes the four notification sounds of M14-25 into `public/sounds/`.
 *
 * The files are synthesised here, so they are the project's own work and carry
 * no third-party licence: sine tones with a soft attack and a decaying tail,
 * 16-bit mono at 16 kHz, each under 20 KB. They are dedicated to the public
 * domain under CC0 1.0, which `docs/guides/notifications.md` also states.
 *
 * Run `node scripts/generate-sounds.ts` to regenerate them; the output is
 * deterministic, so a diff means the notes changed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SAMPLE_RATE = 16_000;
const OUT = join(import.meta.dirname, '..', 'public', 'sounds');

interface Note {
  /** Frequency in hertz. */
  readonly hz: number;
  /** Seconds from the start of the file. */
  readonly at: number;
  readonly length: number;
  readonly gain: number;
}

const SOUNDS: Record<string, readonly Note[]> = {
  // Two falling notes, the most insistent: somebody is waiting.
  'waiting-chat': [
    { hz: 880, at: 0, length: 0.28, gain: 0.5 },
    { hz: 659.25, at: 0.22, length: 0.42, gain: 0.5 },
  ],
  // One soft high chime.
  'new-conversation': [{ hz: 1046.5, at: 0, length: 0.45, gain: 0.45 }],
  // Two quick short pops.
  'customer-reply': [
    { hz: 783.99, at: 0, length: 0.1, gain: 0.45 },
    { hz: 783.99, at: 0.13, length: 0.14, gain: 0.45 },
  ],
  // A short rising pair.
  'assigned-or-mentioned': [
    { hz: 587.33, at: 0, length: 0.16, gain: 0.45 },
    { hz: 880, at: 0.14, length: 0.34, gain: 0.45 },
  ],
};

const render = (notes: readonly Note[]): Int16Array => {
  const total = Math.max(...notes.map((note) => note.at + note.length));
  const samples = new Float64Array(Math.ceil(total * SAMPLE_RATE));
  for (const note of notes) {
    const start = Math.round(note.at * SAMPLE_RATE);
    const count = Math.round(note.length * SAMPLE_RATE);
    for (let i = 0; i < count && start + i < samples.length; i += 1) {
      const t = i / SAMPLE_RATE;
      const attack = Math.min(1, t / 0.008);
      const decay = Math.exp((-5 * i) / count);
      const tone =
        Math.sin(2 * Math.PI * note.hz * t) + 0.25 * Math.sin(2 * Math.PI * note.hz * 2 * t);
      samples[start + i] = (samples[start + i] ?? 0) + note.gain * attack * decay * tone * 0.8;
    }
  }

  return Int16Array.from(samples, (value) => Math.round(Math.max(-1, Math.min(1, value)) * 32_767));
};

const wav = (pcm: Int16Array): Buffer => {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
};

mkdirSync(OUT, { recursive: true });
for (const [name, notes] of Object.entries(SOUNDS)) {
  writeFileSync(join(OUT, `${name}.wav`), wav(render(notes)));
}
