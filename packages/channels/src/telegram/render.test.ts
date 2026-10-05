import { describe, expect, it } from 'vitest';
import {
  csatCommentKeyboard,
  csatKeyboard,
  languageKeyboard,
  locationText,
  mapLinkFor,
  splitTelegramText,
} from './render.js';

describe('splitTelegramText', () => {
  it('sends a short reply as one part', () => {
    expect(splitTelegramText('  Hello Mona  ')).toEqual(['Hello Mona']);
  });

  it('sends nothing for an empty reply', () => {
    expect(splitTelegramText('   ')).toEqual([]);
  });

  it('cuts a long reply at a paragraph before a line or a word', () => {
    const first = 'a'.repeat(30);
    const second = 'b'.repeat(15);
    expect(splitTelegramText(`${first}\n\n${second}`, 40)).toEqual([first, second]);
    expect(splitTelegramText(`${first}\n${second}`, 40)).toEqual([first, second]);
    expect(splitTelegramText(`${first} ${second}`, 40)).toEqual([first, second]);
  });

  it('cuts a word longer than a message where it has to', () => {
    expect(splitTelegramText('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
  });

  it('never splits a character made of two code units', () => {
    const parts = splitTelegramText('𝒜'.repeat(5), 2);
    expect(parts).toEqual(['𝒜𝒜', '𝒜𝒜', '𝒜']);
  });
});

describe('locations', () => {
  const point = { latitude: 52.52, longitude: 13.405, title: null, address: null };

  it('links to the point on OpenStreetMap', () => {
    expect(mapLinkFor(point)).toBe(
      'https://www.openstreetmap.org/?mlat=52.52&mlon=13.405#map=17/52.52/13.405',
    );
  });

  it('writes "Location: lat, long" in the contact’s words, then the link', () => {
    expect(locationText(point, 'الموقع').split('\n')).toEqual([
      'الموقع: 52.52, 13.405',
      mapLinkFor(point),
    ]);
  });

  it('adds a venue’s name and address', () => {
    expect(
      locationText({ ...point, title: 'Acme Store', address: 'Main St 1' }, 'Location').split('\n'),
    ).toEqual(['Location: 52.52, 13.405', 'Acme Store', 'Main St 1', mapLinkFor(point)]);
  });
});

it('offers both languages, each in its own words', () => {
  expect(languageKeyboard().inline_keyboard).toEqual([
    [
      { text: 'English', callback_data: 'lang:en' },
      { text: 'العربية', callback_data: 'lang:ar' },
    ],
  ]);
});

it('draws the survey as five score buttons in a row, then the comment link', () => {
  const surveyId = '0192c3f0-1a2b-7c3d-8e4f-000000000042';
  const comment = { label: 'Add a comment', url: 'https://desk.test/csat/tok?lang=en' };
  const { inline_keyboard: rows } = csatKeyboard(surveyId, comment);

  expect(rows[0]).toEqual(
    [1, 2, 3, 4, 5].map((rating) => ({
      text: String(rating),
      callback_data: `csat:${surveyId}:${String(rating)}`,
    })),
  );
  expect(rows[1]).toEqual([{ text: 'Add a comment', url: comment.url }]);
  expect(csatCommentKeyboard(comment).inline_keyboard).toEqual([rows[1]]);
});
