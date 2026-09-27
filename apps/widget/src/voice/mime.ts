/**
 * R §4.6: WebM/Opus where the browser records it, MP4/AAC on Safari. The
 * server normalises either to Opus (ARCHITECTURE §9).
 */
const CANDIDATES = [
  { mime: 'audio/webm;codecs=opus', extension: 'webm' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mime: 'audio/mp4', extension: 'm4a' },
] as const;

export function pickRecordingFormat(
  isSupported: (mime: string) => boolean,
): { mime: string; extension: string } | null {
  return CANDIDATES.find((candidate) => isSupported(candidate.mime)) ?? null;
}

/** `voice-2026-09-27-0941.webm`: sortable, and says what it is in an agent's download folder. */
export function recordingName(extension: string, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `voice-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${extension}`;
}
