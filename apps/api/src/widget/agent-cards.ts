import { jobTitleFor, publicNameOf, type ReplyLanguage } from '@helpdock/schemas';
import type { ProfilePhotoStore } from '../staff/profile-photo.store.js';
import type { StaffIdentityRow } from './widget.repository.js';

/**
 * A staff member as a visitor of the widget is shown them (M4-08, M14-12): the
 * name they chose to be called, their job title in the conversation's
 * language, and their photo as a five-minute presigned URL. Nothing else about
 * the account is in this type, so nothing else can reach the wire.
 */
export interface AgentCard {
  readonly name: string;
  readonly title: string | null;
  readonly avatarUrl: string | null;
}

/**
 * Builds cards from the rows the widget repository read. A photo is presigned
 * only for the people a conversation actually names, and only after the caller
 * already holds the brand's visitor scope, so the authorisation is the
 * conversation's: a visitor can be shown the photo of whoever wrote in their own
 * conversation, and of nobody else.
 */
export class AgentCards {
  readonly #photos: Pick<ProfilePhotoStore, 'smallUrl'>;

  constructor(photos: Pick<ProfilePhotoStore, 'smallUrl'>) {
    this.#photos = photos;
  }

  async of(
    rows: ReadonlyMap<string, StaffIdentityRow>,
    language: ReplyLanguage,
  ): Promise<ReadonlyMap<string, AgentCard>> {
    const cards = new Map<string, AgentCard>();
    for (const [id, row] of rows) {
      cards.set(id, {
        name: publicNameOf(row),
        title: jobTitleFor(row, language),
        avatarUrl: await this.#photos.smallUrl(row.photoKey),
      });
    }

    return cards;
  }
}
