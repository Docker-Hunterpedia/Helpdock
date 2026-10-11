import { locationText } from '../telegram/render.js';
import type { MetaPoint, MetaSharedContact, MetaStory } from './envelope.js';

/**
 * Text going out to a Meta customer, and the text a location, a shared contact
 * and a story come in as (M10-01; used by M10-03 to M10-06). Every platform is
 * sent plain text: nothing an agent typed can be read as markup.
 */

/**
 * The splitter moved to `@helpdock/schemas` (M10-08) so the admin composer can
 * count the messages a reply becomes with the code that cuts them. It is
 * re-exported here, where the send job and the view have always found it.
 */
export { splitMetaText } from '@helpdock/schemas';

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
