import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpTransport } from './http.js';
import { AiHttpError } from './http.js';
import { InMemoryAiPorts } from './testing.js';
import { createTranscribe, localeOfLanguage } from './transcribe.js';

const config = {
  endpoint: 'https://whisper.test/v1/audio/transcriptions',
  model: 'whisper-1',
  apiKey: 'sk-whisper',
};

const whisper = (status: number, body: unknown) => {
  const sent: HttpRequest[] = [];
  const http: HttpTransport = (_url, request) => {
    sent.push(request);
    return Promise.resolve({ status, body: JSON.stringify(body) });
  };
  return { http, sent };
};

const request = {
  brandId: 'brand-1',
  ticketId: 'ticket-1',
  config,
  audio: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
  fileName: 'voice "1".ogg',
  mime: 'audio/ogg',
};

describe('transcribe', () => {
  it('posts the audio as multipart with the model and logs the transcript', async () => {
    const ports = new InMemoryAiPorts();
    const fake = whisper(200, { text: ' Hello there ', language: 'english' });
    const transcribe = createTranscribe({ ports, http: fake.http, clock: () => 0 });

    const result = await transcribe(request);

    expect(result).toEqual({ callId: 'call-1', text: 'Hello there', language: 'english' });
    const sent = fake.sent[0];
    expect(sent?.headers.authorization).toBe('Bearer sk-whisper');
    const body = Buffer.from(sent?.body as Uint8Array).toString('latin1');
    expect(body).toContain('name="model"\r\n\r\nwhisper-1');
    expect(body).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(body).toContain('filename="voice 1.ogg"');
    expect(body).toContain('OggS');
    expect(ports.calls[0]).toMatchObject({
      feature: 'transcribe',
      provider: 'whisper.test',
      status: 'ok',
      response: 'Hello there',
      costUsd: 0,
    });
  });

  it('logs and throws a refusal by the endpoint', async () => {
    const ports = new InMemoryAiPorts();
    const transcribe = createTranscribe({
      ports,
      http: whisper(400, { error: 'bad audio' }).http,
      clock: () => 0,
    });

    await expect(transcribe(request)).rejects.toBeInstanceOf(AiHttpError);
    expect(ports.calls[0]).toMatchObject({ status: 'error', response: null });
  });

  it('answers a null language when the endpoint names none', async () => {
    const transcribe = createTranscribe({
      ports: new InMemoryAiPorts(),
      http: whisper(200, { text: 'hi' }).http,
      clock: () => 0,
    });

    expect(
      (await transcribe({ ...request, config: { ...config, apiKey: '' } })).language,
    ).toBeNull();
  });
});

describe('localeOfLanguage', () => {
  it('maps the names Whisper uses to the two catalogs', () => {
    expect(localeOfLanguage('Arabic')).toBe('ar');
    expect(localeOfLanguage('ar')).toBe('ar');
    expect(localeOfLanguage('english')).toBe('en');
    expect(localeOfLanguage('en')).toBe('en');
    expect(localeOfLanguage('french')).toBeNull();
    expect(localeOfLanguage(null)).toBeNull();
  });
});
