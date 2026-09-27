import { describe, expect, it } from 'vitest';
import { pickRecordingFormat, recordingName } from './mime.js';

describe('pickRecordingFormat', () => {
  it('prefers WebM/Opus', () => {
    expect(pickRecordingFormat(() => true)).toEqual({
      mime: 'audio/webm;codecs=opus',
      extension: 'webm',
    });
  });

  it('falls back to MP4/AAC where only Safari’s format records', () => {
    expect(pickRecordingFormat((mime) => mime.startsWith('audio/mp4'))?.extension).toBe('m4a');
  });

  it('returns null when neither records, leaving the choice to the browser', () => {
    expect(pickRecordingFormat(() => false)).toBeNull();
  });
});

describe('recordingName', () => {
  it('is a sortable local timestamp with the right extension', () => {
    expect(recordingName('webm', new Date(2026, 8, 27, 9, 41))).toBe('voice-2026-09-27-0941.webm');
  });
});
