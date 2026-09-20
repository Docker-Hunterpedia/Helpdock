import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaTools, MediaToolError, type MediaTools } from './ffmpeg.js';
import { sniffFamily } from './magic-bytes.js';
import { TIMEOUTS_MS } from './process.job.js';

/**
 * The two external binaries, against the real thing (M1-10).
 *
 * It needs no containers, only `ffmpeg` and `ffprobe` on `PATH` — which is what
 * the Docker image ships and what CI installs. Without them the suite skips
 * itself with a message, because a worker with no ffmpeg is a supported
 * deployment: `FFMPEG_PATH` is optional, images and files still work, and audio
 * and video are rejected with `processing_failed`.
 *
 * What it proves is the part a double cannot: that the arguments in
 * `ffmpeg.ts` produce the encoding ARCHITECTURE §9 fixes — Opus in an Ogg
 * container at 48 kHz mono, a WebP poster frame — and that a deadline really
 * kills the process rather than waiting on it.
 */

const run = promisify(execFile);

const found = async (binary: string): Promise<boolean> =>
  run(binary, ['-version'], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );

const hasFfmpeg = (await found('ffmpeg')) && (await found('ffprobe'));

if (!hasFfmpeg) {
  process.stderr.write(
    'Skipping the ffmpeg media tests: ffmpeg and ffprobe are not on PATH. Install them (apt install ffmpeg, brew install ffmpeg) and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasFfmpeg)('the media tools', () => {
  let dir: string;
  let tools: MediaTools;
  let sourceAudio: string;
  let sourceVideo: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'helpdock-ffmpeg-'));
    tools = createMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });

    // Two seconds of a sine wave in a WebM/Opus container: what a Chromium
    // `MediaRecorder` produces for a voice note.
    sourceAudio = path.join(dir, 'voice.webm');
    await run('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      '-y',
      sourceAudio,
    ]);

    // Three seconds of colour bars with an audio track, in MP4.
    sourceVideo = path.join(dir, 'clip.mp4');
    await run('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      '-y',
      sourceVideo,
    ]);
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('normalises a WebM/Opus voice note to Opus in an Ogg container', async () => {
    const output = path.join(dir, 'out.opus');

    await tools.toOpus({ input: sourceAudio, output, timeoutMs: TIMEOUTS_MS.audio });

    // The sniffer has to recognise what the worker wrote: `variants.opus` is
    // served as `audio/ogg`.
    expect(sniffFamily(await readFile(output))).toBe('ogg');

    const { stdout } = await run('ffprobe', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels',
      '-of',
      'default=noprint_wrappers=1',
      output,
    ]);

    // ARCHITECTURE §9: "normalize to Opus/OGG 48 kHz mono 32 kbps".
    expect(stdout).toContain('codec_name=opus');
    expect(stdout).toContain('sample_rate=48000');
    expect(stdout).toContain('channels=1');
  }, 120_000);

  it('drops metadata on the way through', async () => {
    const tagged = path.join(dir, 'tagged.webm');
    await run('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourceAudio,
      '-c',
      'copy',
      '-metadata',
      'title=a private note',
      '-y',
      tagged,
    ]);

    const output = path.join(dir, 'untagged.opus');
    await tools.toOpus({ input: tagged, output, timeoutMs: TIMEOUTS_MS.audio });

    const { stdout } = await run('ffprobe', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-show_entries',
      'format_tags',
      '-of',
      'default=noprint_wrappers=1',
      output,
    ]);

    expect(stdout).not.toContain('a private note');
  }, 120_000);

  it('reports the duration of what it wrote', async () => {
    const output = path.join(dir, 'duration.opus');
    await tools.toOpus({ input: sourceAudio, output, timeoutMs: TIMEOUTS_MS.audio });

    const durationMs = await tools.durationMs({ input: output, timeoutMs: TIMEOUTS_MS.ffprobe });

    expect(durationMs).toBeGreaterThan(1_500);
    expect(durationMs).toBeLessThan(2_500);
  }, 120_000);

  it('takes one PNG frame a second into a video', async () => {
    // PNG and not WebP: ffmpeg's `libwebp` is an optional build flag, and a
    // poster that depends on how somebody compiled ffmpeg is a poster that
    // works on one install and not the next. sharp makes the WebP that is
    // stored (`process.job.ts`).
    const output = path.join(dir, 'frame.png');

    await tools.posterFrame({
      input: sourceVideo,
      output,
      atSeconds: 1,
      timeoutMs: TIMEOUTS_MS.poster,
    });

    expect(sniffFamily(await readFile(output))).toBe('png');
    const { size } = await stat(output);
    expect(size).toBeGreaterThan(0);
  }, 120_000);

  it('reports a video’s duration', async () => {
    const durationMs = await tools.durationMs({
      input: sourceVideo,
      timeoutMs: TIMEOUTS_MS.ffprobe,
    });

    expect(durationMs).toBeGreaterThan(2_500);
    expect(durationMs).toBeLessThan(3_500);
  }, 60_000);

  it('refuses a file that is not what its container claims', async () => {
    const notAudio = path.join(dir, 'not-audio.webm');
    await run('sh', ['-c', `printf 'definitely not media' > ${JSON.stringify(notAudio)}`]);

    await expect(
      tools.toOpus({ input: notAudio, output: path.join(dir, 'x.opus'), timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(MediaToolError);
  }, 60_000);

  it('kills a conversion that runs past its deadline rather than waiting on it', async () => {
    // A millisecond is not enough for any real encode, which is the point: a
    // crafted file that makes a decoder loop must not be a worker that never
    // drains its queue.
    const error = await tools
      .toOpus({ input: sourceAudio, output: path.join(dir, 'slow.opus'), timeoutMs: 1 })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as MediaToolError);

    expect(error).toBeInstanceOf(MediaToolError);
    expect(error?.timedOut).toBe(true);
    // The detail exists for a log line and never for a `reject_reason`.
    expect(error?.message).toBe('ffmpeg failed');
  }, 60_000);
});
