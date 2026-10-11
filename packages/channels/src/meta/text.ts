import { META_TEXT_LIMITS, type MetaPlatform } from '@helpdock/schemas';
import { locationText } from '../telegram/render.js';
import type { MetaPoint, MetaSharedContact, MetaStory } from './envelope.js';

/**
 * Text going out to a Meta customer, and the text a location, a shared contact
 * and a story come in as (M10-01; used by M10-03 to M10-06). Every platform is
 * sent plain text: nothing an agent typed can be read as markup.
 */

const encoder = new TextEncoder();

/**
 * How much of a platform's limit a run of text uses. WhatsApp and Messenger
 * say "characters" without saying how they count a character outside the Basic
 * Multilingual Plane, so UTF-16 code units are counted: never fewer than
 * code points, which keeps a part under the limit either way. Instagram counts
 * UTF-8 **bytes**, which is two per Arabic letter.
 */
const measureOf = (platform: MetaPlatform): ((text: string) => number) =>
  META_TEXT_LIMITS[platform].unit === 'bytes'
    ? (text) => encoder.encode(text).byteLength
    : (text) => text.length;

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

/** Separators in the order a cut prefers them: a paragraph, then a line, then a space. */
const SEPARATORS = ['\n\n', '\n', ' '] as const;

/**
 * A reply in the parts a platform accepts: at most `META_TEXT_LIMITS[platform]`
 * each, cut at a paragraph, then a line, then a space, and only mid-word when
 * one word is longer than a part. A cut never splits a code point, so a part of
 * Arabic text on Instagram ends at a letter, whatever the byte count says.
 *
 * Whitespace around a cut is dropped, nothing else is: joining the parts with
 * a space gives the text back.
 */
export const splitMetaText = (text: string, platform: MetaPlatform): string[] => {
  const limit = META_TEXT_LIMITS[platform].max;
  const measure = measureOf(platform);
  const parts: string[] = [];
  let rest = [...text.trim()];

  while (measure(rest.join('')) > limit) {
    // The longest run of code points that fits.
    let fitted = 0;
    let used = 0;
    for (const point of rest) {
      const size = measure(point);
      if (used + size > limit) {
        break;
      }
      used += size;
      fitted += 1;
    }
    if (fitted === 0) {
      throw new RangeError(`A single character does not fit in ${String(limit)} ${platform} units`);
    }

    const head = rest.slice(0, fitted);
    const cut = SEPARATORS.map((separator) => lastIndexOf(head, separator)).find(
      (index) => index > 0 && measure(head.slice(0, index).join('')) > limit / 2,
    );
    const at = cut ?? fitted;
    parts.push(rest.slice(0, at).join('').trimEnd());
    rest = [...rest.slice(at).join('').trimStart()];
  }

  const last = rest.join('');
  if (last !== '') {
    parts.push(last);
  }

  return parts;
};

/**
 * "Location: 52.52, 13.405", the venue, and a map link: the line Telegram
 * writes, for a WhatsApp location message. `label` is the word for "Location"
 * in the contact's language.
 */
export const metaLocationText = (point: MetaPoint, label: string): string =>
  locationText(
    {
      latitude: point.latitude,
      longitude: point.longitude,
      title: point.name,
      address: point.address,
    },
    label,
  );

/**
 * Shared contacts as text: each contact's name after `label` ("Contact"), then
 * its numbers and addresses on lines of their own. Contacts are separated by a
 * blank line.
 */
export const contactsText = (contacts: readonly MetaSharedContact[], label: string): string =>
  contacts
    .map((contact) =>
      [
        contact.name === '' ? label : `${label}: ${contact.name}`,
        ...(contact.org === null ? [] : [contact.org]),
        ...contact.phones,
        ...contact.emails,
      ].join('\n'),
    )
    .join('\n\n');

/** What the two story labels say, in the contact's language. */
export interface StoryLabels {
  /** "Replied to your story". */
  readonly reply: string;
  /** "Mentioned you in their story". */
  readonly mention: string;
}

/** The line that names a story a customer replied to or mentioned, with its link when Meta gave one. */
export const storyText = (story: MetaStory, labels: StoryLabels): string =>
  [
    story.kind === 'reply' ? labels.reply : labels.mention,
    ...(story.url === null ? [] : [story.url]),
  ].join('\n');
