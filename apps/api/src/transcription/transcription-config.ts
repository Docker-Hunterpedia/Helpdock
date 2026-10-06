import type { TranscriptionConfig } from '@helpdock/ai';
import type { Settings } from '@helpdock/config';

/**
 * The install's Whisper-compatible endpoint (M7-09), as `Admin/AI-Providers`
 * (M7-10) or the `HD_TRANSCRIPTION_*` variables set it. Null while the
 * endpoint is empty: transcription is off and voice notes keep no transcript.
 */
export type TranscriptionConfigReader = () => Promise<TranscriptionConfig | null>;

export const transcriptionConfigFrom =
  (settings: Pick<Settings, 'get'>): TranscriptionConfigReader =>
  async () => {
    const [endpoint, model, apiKey] = await Promise.all([
      settings.get('transcription.endpoint'),
      settings.get('transcription.model'),
      settings.get('transcription.apiKey'),
    ]);
    return endpoint === '' ? null : { endpoint, model, apiKey };
  };
