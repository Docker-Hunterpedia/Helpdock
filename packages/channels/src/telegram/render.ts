import type { InlineKeyboardMarkup } from 'grammy/types';
import { TELEGRAM_MESSAGE_MAX_LENGTH } from './bot-api.js';
import type { TelegramPoint } from './update.js';

/**
 * Text going out to a chat, and the text a location comes in as (M6-02,
 * M6-03, M6-04). Telegram is sent plain text — no `parse_mode` — so nothing an
 * agent typed can be read as markup.
 */

/**
 * A reply in parts Telegram accepts: at most 4096 characters each, cut at a
 * paragraph, then a line, then a space, and only mid-word when a single word is
 * longer than a message. Counted in code points so a cut never splits a
 * surrogate pair.
 */
export const splitTelegramText = (
  text: string,
  limit: number = TELEGRAM_MESSAGE_MAX_LENGTH,
): string[] => {
  const parts: string[] = [];
  let rest = [...text.trim()];

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = ['\n\n', '\n', ' ']
      .map((separator) => lastIndexOf(window, separator))
      .find((index) => index > limit / 2);
    const at = cut ?? limit;
    parts.push(rest.slice(0, at).join('').trimEnd());
    rest = [...rest.slice(at).join('').trimStart()];
  }

  const last = rest.join('');
  if (last !== '') {
    parts.push(last);
  }

  return parts;
};

/** Where `separator` last starts in a run of code points, or -1. */
const lastIndexOf = (points: readonly string[], separator: string): number => {
  const needle = [...separator];
  for (let index = points.length - needle.length; index >= 0; index -= 1) {
    if (needle.every((point, offset) => points[index + offset] === point)) {
      return index;
    }
  }
  return -1;
};

/** OpenStreetMap, which needs no key and tracks nobody who follows the link. */
export const mapLinkFor = ({ latitude, longitude }: TelegramPoint): string =>
  `https://www.openstreetmap.org/?mlat=${String(latitude)}&mlon=${String(longitude)}#map=17/${String(latitude)}/${String(longitude)}`;

/**
 * "Location: 52.52, 13.405" and the map link (REQUIREMENTS §4.4: "locations
 * (stored as text)"). `label` is the word for "Location" in the contact's
 * language; a venue adds its name and address.
 */
export const locationText = (point: TelegramPoint, label: string): string =>
  [
    `${label}: ${String(point.latitude)}, ${String(point.longitude)}`,
    ...(point.title === null ? [] : [point.title]),
    ...(point.address === null ? [] : [point.address]),
    mapLinkFor(point),
  ].join('\n');

/** M6-04: English / العربية under the welcome, each naming itself in its own language. */
export const languageKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: 'English', callback_data: 'lang:en' },
      { text: 'العربية', callback_data: 'lang:ar' },
    ],
  ],
});
