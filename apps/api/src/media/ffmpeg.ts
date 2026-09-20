import { execFile } from 'node:child_process';
import { OPUS_BITRATE, OPUS_CHANNELS, OPUS_SAMPLE_RATE } from './variants.js';

/**
 * The two external binaries the media pipeline spawns (ARCHITECTURE §1:
 * "Audio/video — ffmpeg (static binary in image)").
 *
 * **Arguments are an array and never a string.** `execFile` passes them to the
 * kernel as `argv`, with no shell between: there is no word splitting, no glob
 * expansion and no `;`, so a filename cannot become a second command. That is
 * the whole of the argument-injection defence and it is why nothing here builds
 * a command line.
 *
 * Even so, no caller-controlled text reaches these calls. The only paths passed
 * are temporary files this process created with names it generated, and the
 * encoder settings are constants in `variants.ts`. A filename a stranger chose
 * never leaves the database column it is stored in.
 *
 * **Every call has a deadline and an output cap.** A crafted file that makes a
 * decoder loop is a worker that never drains its queue, so the process is
 * killed rather than waited on, and stderr is bounded because it is a stream an
 * attacker can make long.
 */

/** Enough for a diagnostic line, small enough that it cannot be a payload. */
const MAX_STDERR_BYTES = 64 * 1024;

/** A spawned tool failed, timed out, or was not installed. */
export class MediaToolError extends Error {
  readonly tool: string;
  readonly timedOut: boolean;
  /** Bounded, and **never** put in a `reject_reason`: it quotes the worker's paths. */
  readonly detail: string;

  constructor(tool: string, detail: string, timedOut: boolean) {
    super(`${tool} failed`);
    this.name = 'MediaToolError';
    this.tool = tool;
    this.timedOut = timedOut;
    this.detail = detail;
  }
}

export interface MediaToolPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

const run = (binary: string, args: readonly string[], timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_STDERR_BYTES,
        // An inherited environment is how a worker's secrets would reach a
        // child process that has no use for them.
        env: { PATH: process.env.PATH ?? '' },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }

        const timedOut = (error as { killed?: boolean }).killed === true;
        reject(
          new MediaToolError(
            binary,
            `${error.message}\n${stderr}`.slice(0, MAX_STDERR_BYTES),
            timedOut,
          ),
        );
      },
    );
  });

/** What the pipeline needs of ffmpeg. A unit test hands the worker a double. */
export interface MediaTools {
  /**
   * Normalises a voice note to Opus in an Ogg container, 48 kHz mono 32 kbps
   * (ARCHITECTURE §9). Whatever arrived — WebM/Opus from Chromium, MP4/AAC from
   * Safari — leaves as the same thing.
   */
  toOpus(options: { input: string; output: string; timeoutMs: number }): Promise<void>;
  /**
   * One frame as PNG, for a video's poster.
   *
   * PNG rather than WebP on purpose: ffmpeg's WebP encoder is `libwebp`, which
   * a distribution build may be compiled without — and a poster that depends on
   * how somebody's ffmpeg was configured is a poster that works on one install
   * and not the next. sharp turns the frame into the WebP that is stored, which
   * is also the encoder every other image here goes through.
   */
  posterFrame(options: {
    input: string;
    output: string;
    atSeconds: number;
    timeoutMs: number;
  }): Promise<void>;
  /** The stream's duration in milliseconds, or `undefined` if it has none. */
  durationMs(options: { input: string; timeoutMs: number }): Promise<number | undefined>;
}

export const createMediaTools = ({ ffmpeg, ffprobe }: MediaToolPaths): MediaTools => ({
  async toOpus({ input, output, timeoutMs }) {
    await run(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        // The input is a local file and nothing else. Left open, ffmpeg reads
        // protocols out of what it is given — `concat:`, `http:`, `subfile:` —
        // and a crafted "voice note" becomes an outbound request from the
        // worker (DOMAIN-RULES §13 is the same rule for the HTTP client).
        '-protocol_whitelist',
        'file',
        '-i',
        input,
        '-vn',
        '-map_metadata',
        '-1',
        '-c:a',
        'libopus',
        '-b:a',
        OPUS_BITRATE,
        '-ar',
        String(OPUS_SAMPLE_RATE),
        '-ac',
        String(OPUS_CHANNELS),
        '-f',
        'ogg',
        '-y',
        output,
      ],
      timeoutMs,
    );
  },

  async posterFrame({ input, output, atSeconds, timeoutMs }) {
    await run(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'file',
        // Before `-i`, so ffmpeg seeks instead of decoding up to the timestamp.
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-an',
        '-map_metadata',
        '-1',
        '-c:v',
        'png',
        '-f',
        'image2',
        '-y',
        output,
      ],
      timeoutMs,
    );
  },

  async durationMs({ input, timeoutMs }) {
    const stdout = await run(
      ffprobe,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
      ],
      timeoutMs,
    );

    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  },
});
