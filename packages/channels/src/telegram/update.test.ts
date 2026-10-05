import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { classifyUpdate } from './update.js';

const chat = { id: 4242, type: 'private', first_name: 'Mona' };
const from = {
  id: 4242,
  is_bot: false,
  first_name: 'Mona',
  last_name: 'Khalil',
  language_code: 'ar',
};

const message = (fields: Record<string, unknown>) => ({
  update_id: 7,
  message: { message_id: 11, date: 1_790_000_000, chat, from, ...fields },
});

describe('classifyUpdate', () => {
  it('reads a text message with its sender', () => {
    expect(classifyUpdate(message({ text: '  My order is late  ' }))).toEqual({
      kind: 'message',
      updateId: 7,
      messageId: 11,
      sender: { chatId: '4242', name: 'Mona Khalil', username: null, languageCode: 'ar' },
      text: 'My order is late',
      files: [],
      location: null,
      sentAt: new Date(1_790_000_000_000),
    });
  });

  it('takes the largest photo size and the caption as the text', () => {
    const event = classifyUpdate(
      message({
        caption: 'the damage',
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1_000 },
          { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280, file_size: 90_000 },
        ],
      }),
    );

    expect(event).toMatchObject({
      kind: 'message',
      text: 'the damage',
      files: [{ fileId: 'large', filename: 'photo.jpg', contentType: 'image/jpeg', size: 90_000 }],
    });
  });

  it('reads documents, voice notes, audio and video as files', () => {
    const event = classifyUpdate(
      message({
        document: { file_id: 'doc', file_name: 'invoice.pdf', mime_type: 'application/pdf' },
        voice: { file_id: 'voice', duration: 3 },
        audio: { file_id: 'audio', duration: 3 },
        video: { file_id: 'video', duration: 3, width: 1, height: 1 },
      }),
    );

    expect(event.kind === 'message' ? event.files : []).toEqual([
      { fileId: 'doc', filename: 'invoice.pdf', contentType: 'application/pdf', size: null },
      { fileId: 'voice', filename: 'voice.ogg', contentType: 'audio/ogg', size: null },
      { fileId: 'audio', filename: 'audio', contentType: 'application/octet-stream', size: null },
      { fileId: 'video', filename: 'video.mp4', contentType: 'video/mp4', size: null },
    ]);
  });

  it('reads a location, and a venue with its name and address', () => {
    expect(
      classifyUpdate(message({ location: { latitude: 52.52, longitude: 13.405 } })),
    ).toMatchObject({
      kind: 'message',
      location: { latitude: 52.52, longitude: 13.405, title: null, address: null },
    });
    expect(
      classifyUpdate(
        message({
          venue: {
            location: { latitude: 1, longitude: 2 },
            title: 'Acme Store',
            address: 'Main St 1',
          },
        }),
      ),
    ).toMatchObject({ location: { title: 'Acme Store', address: 'Main St 1' } });
  });

  it('recognises /start, with or without a payload or the bot name', () => {
    for (const text of ['/start', '/start campaign-7', '/start@acme_bot']) {
      expect(classifyUpdate(message({ text })).kind).toBe('start');
    }
    expect(classifyUpdate(message({ text: '/started the order' })).kind).toBe('message');
  });

  it('reads a language button press', () => {
    const event = classifyUpdate({
      update_id: 8,
      callback_query: {
        id: 'cq-1',
        from: { ...from, username: 'mona_k' },
        message: { message_id: 3, chat },
        data: 'lang:ar',
      },
    });

    expect(event).toEqual({
      kind: 'language',
      updateId: 8,
      callbackQueryId: 'cq-1',
      locale: 'ar',
      sender: { chatId: '4242', name: 'Mona Khalil', username: 'mona_k', languageCode: 'ar' },
    });
  });

  it('ignores what a ticket is not made of', () => {
    expect(classifyUpdate({ update_id: 1, edited_message: {} })).toMatchObject({
      kind: 'ignored',
      reason: 'unsupported-update',
    });
    expect(
      classifyUpdate(message({ chat: { id: -100, type: 'group' }, text: 'hi all' })),
    ).toMatchObject({ reason: 'not-private' });
    expect(
      classifyUpdate(message({ from: { ...from, is_bot: true }, text: 'beep' })),
    ).toMatchObject({ reason: 'from-bot' });
    expect(classifyUpdate(message({ sticker: { file_id: 'x' } }))).toMatchObject({
      reason: 'unsupported-content',
    });
    expect(
      classifyUpdate({
        update_id: 2,
        callback_query: { id: 'cq', from, message: { message_id: 1, chat }, data: 'buy:42' },
      }),
    ).toMatchObject({ reason: 'unknown-callback' });
    expect(
      classifyUpdate({ update_id: 3, callback_query: { id: 'cq', from, data: 'lang:en' } }),
    ).toMatchObject({ reason: 'not-private' });
  });

  it('names a sender with no name by their username', () => {
    const event = classifyUpdate(
      message({ from: { id: 1, is_bot: false, first_name: '', username: 'mona' }, text: 'hi' }),
    );
    expect(event.kind === 'message' ? event.sender.name : undefined).toBe('@mona');
  });

  it('refuses a body that is not an update', () => {
    expect(() => classifyUpdate({ hello: 'world' })).toThrow(ZodError);
  });
});
