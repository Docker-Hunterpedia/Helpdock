import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AiHttpError, bearer, type HttpTransport } from './http.js';
import type { AiPorts } from './ports.js';

/**
 * `transcribe()`: a voice note's words, from a Whisper-compatible endpoint
 * (M7-09, ARCHITECTURE §9) — OpenAI's `POST /v1/audio/transcriptions`, or a
 * local faster-whisper or whisper.cpp server that speaks the same API. One
 * multipart request with the audio, `response_format=verbose_json` so the
 * answer names the language it heard.
 *
 * Logged to `ai_calls` like every model call, as feature `transcribe`, with
 * the transcript as the response. The audio is not text, so there is nothing
 * to redact on the way in; the transcript is shown to staff only. Not stopped
 * by the budget, like embeddings: the endpoint is priced by the minute and
 * the install has no price for it, so its calls cost 0 in the log.
 */

export interface TranscriptionConfig {
  /** The full URL, for example `https://api.openai.com/v1/audio/transcriptions`. */
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface TranscribeRequest {
  readonly brandId: string;
  readonly ticketId: string;
  readonly config: TranscriptionConfig;
  readonly audio: Uint8Array;
  /** The file name the endpoint sees; its extension is how Whisper reads the format. */
  readonly fileName: string;
  readonly mime: string;
}

export interface TranscribeResult {
  readonly callId: string;
  readonly text: string;
  /** As the endpoint named it (`arabic`, `en`), or null when it did not say. */
  readonly language: string | null;
}

const answerSchema = z.object({
  text: z.string(),
  language: z.string().nullish(),
});

/** `arabic`, `Arabic`, `ar` → `ar`; `english`, `en` → `en`; anything else null. */
export const localeOfLanguage = (language: string | null): 'en' | 'ar' | null => {
  const normalized = language?.trim().toLowerCase() ?? '';
  if (normalized === 'ar' || normalized === 'arabic') {
    return 'ar';
  }
  if (normalized === 'en' || normalized === 'english') {
    return 'en';
  }
  return null;
};

const multipart = (
  fields: Readonly<Record<string, string>>,
  file: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array },
): { readonly body: Uint8Array; readonly contentType: string } => {
  const boundary = `helpdock-${randomUUID()}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = Object.entries(fields).map(([name, value]) =>
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/["\r\n]/g, '')}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
    file.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  );
  const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

export interface TranscribeDeps {
  readonly ports: Pick<AiPorts, 'record'>;
  readonly http: HttpTransport;
  readonly clock: () => number;
}

export const createTranscribe =
  ({ ports, http, clock }: TranscribeDeps) =>
  async (request: TranscribeRequest): Promise<TranscribeResult> => {
    const { config } = request;
    const { body, contentType } = multipart(
      { model: config.model, response_format: 'verbose_json' },
      { name: request.fileName, mime: request.mime, bytes: request.audio },
    );
    const started = clock();
    const record = (fields: {
      status: 'ok' | 'error';
      response: string | null;
      error: string | null;
    }): Promise<string> =>
      ports.record({
        brandId: request.brandId,
        ticketId: request.ticketId,
        feature: 'transcribe',
        provider: new URL(config.endpoint).host,
        model: config.model,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: Math.round(clock() - started),
        redactions: [],
        prompt: null,
        promptHash: null,
        sources: null,
        ...fields,
      });

    let parsed: z.infer<typeof answerSchema>;
    try {
      const response = await http(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': contentType, ...bearer(config.apiKey) },
        body,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new AiHttpError(config.endpoint, response.status);
      }
      parsed = answerSchema.parse(JSON.parse(response.body));
    } catch (error) {
      await record({
        status: 'error',
        response: null,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    }

    const text = parsed.text.trim();
    const callId = await record({ status: 'ok', response: text, error: null });
    return { callId, text, language: parsed.language ?? null };
  };
