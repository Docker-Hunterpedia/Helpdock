import { type GraphApi, GraphApiFailure, type GraphClient, parseGraph } from '@helpdock/channels';
import type {
  MetaAccount as MetaAccountRow,
  MetaConversation as MetaConversationRow,
} from '@helpdock/db';
import type { MetaProfileFetchPayload } from '@helpdock/jobs';
import { z } from 'zod';

/**
 * What the `meta.profile_fetch` job decides (M10-05, shared with M10-04), as
 * functions of their inputs so each is held to its edge cases in a unit test.
 *
 * A Messenger or Instagram customer's message carries no name. Both platforms
 * allow one read of the customer's profile once they have written to the
 * account, and the webhook does not make it (ADR 0025, 6): the conversation
 * raises a `meta.profile` event beside the message, and the job reads it
 * afterwards. Whatever Graph answers, the job records that it asked
 * (`profile_checked_at`), so a read Meta refuses is made once per conversation.
 */

export type ProfilePlatform = MetaProfileFetchPayload['platform'];

/** The read each platform allows, on the root it is served from. */
export const PROFILE_READS: Readonly<
  Record<ProfilePlatform, { readonly api: GraphApi; readonly fields: string }>
> = {
  instagram: { api: 'instagram', fields: 'name,username' },
  messenger: { api: 'graph', fields: 'first_name,last_name' },
};

export interface MetaProfile {
  readonly name: string | null;
  /** Instagram's `@username` without the `@`; Messenger has none. */
  readonly username: string | null;
}

type ConversationFacts = Pick<MetaConversationRow, 'profileName' | 'username' | 'profileCheckedAt'>;

/**
 * Whether a conversation still wants its customer's name: Graph has not been
 * asked, and nothing else has given one. A conversation that does not exist yet
 * wants it.
 */
export const wantsProfile = (conversation: ConversationFacts | undefined): boolean =>
  conversation === undefined ||
  (conversation.profileCheckedAt === null &&
    conversation.profileName === null &&
    conversation.username === null);

/** Why a queued lookup has nothing to do. */
export type SkipReason = 'conversation-gone' | 'account-gone' | 'wrong-account' | 'answered';

/**
 * Whether the job has anything to read. The conversation or the account may be
 * gone by the time it runs, the event may name an account the conversation is
 * not with, and an earlier lookup (a second event raised by a message that
 * arrived first) may have answered already.
 */
export const planProfileLookup = <
  TConversation extends ConversationFacts & Pick<MetaConversationRow, 'accountId'>,
  TAccount extends Pick<MetaAccountRow, 'id' | 'platform'>,
>(
  payload: Pick<MetaProfileFetchPayload, 'platform'>,
  conversation: TConversation | undefined,
  account: TAccount | undefined,
):
  | { readonly read: true; readonly conversation: TConversation; readonly account: TAccount }
  | { readonly read: false; readonly reason: SkipReason } => {
  if (conversation === undefined) {
    return { read: false, reason: 'conversation-gone' };
  }
  if (account === undefined) {
    return { read: false, reason: 'account-gone' };
  }
  if (conversation.accountId !== account.id || account.platform !== payload.platform) {
    return { read: false, reason: 'wrong-account' };
  }

  return wantsProfile(conversation)
    ? { read: true, conversation, account }
    : { read: false, reason: 'answered' };
};

const textOrNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();

const profileBodySchema = z.looseObject({
  name: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

/**
 * Graph's answer as a name and a handle. Instagram answers `name` and
 * `username`; Messenger `first_name` and `last_name`, which are joined. An
 * answer in a shape Helpdock does not know is a permanent failure, as every
 * Graph response read through `parseGraph` is.
 */
export const parseProfile = (
  platform: ProfilePlatform,
  body: unknown,
  token: string,
): MetaProfile => {
  const parsed = parseGraph(profileBodySchema, body, 'a customer profile', token);
  if (platform === 'instagram') {
    return { name: textOrNull(parsed.name), username: textOrNull(parsed.username) };
  }
  const name = [textOrNull(parsed.first_name), textOrNull(parsed.last_name)]
    .filter((part) => part !== null)
    .join(' ');

  return { name: name === '' ? null : name, username: null };
};

/**
 * What a read came to. `retry` and `token_dead` are not answers: the job tries
 * again later, and a dead token is the account's to fix. Everything else Graph
 * can say is an answer, and `refused` is the one that is recorded and not
 * repeated (the Page lacks the reviewed feature, the customer blocked the
 * account, Meta restricted the account).
 */
export type ProfileRead =
  | { readonly kind: 'named'; readonly profile: MetaProfile }
  | { readonly kind: 'empty' }
  | { readonly kind: 'refused'; readonly failure: GraphApiFailure }
  | { readonly kind: 'retry'; readonly failure: GraphApiFailure }
  | { readonly kind: 'token_dead'; readonly failure: GraphApiFailure };

const readOfFailure = (failure: GraphApiFailure): ProfileRead => {
  switch (failure.kind) {
    case 'token_dead':
      return { kind: 'token_dead', failure };
    case 'retry':
    case 'rate_limited':
      return { kind: 'retry', failure };
    default:
      return { kind: 'refused', failure };
  }
};

/**
 * `GET /{customer id}?fields=…` and what became of it. Anything that is not a
 * {@link GraphApiFailure} is a bug and propagates; a failure never leaves here
 * as an exception.
 */
export const readProfile = async (input: {
  readonly graph: Pick<GraphClient, 'get'>;
  readonly platform: ProfilePlatform;
  readonly customerId: string;
  readonly token: string;
}): Promise<ProfileRead> => {
  const { graph, platform, customerId, token } = input;
  const { api, fields } = PROFILE_READS[platform];
  try {
    const profile = parseProfile(
      platform,
      await graph.get(`/${customerId}`, { token, api, query: { fields } }),
      token,
    );

    return profile.name === null && profile.username === null
      ? { kind: 'empty' }
      : { kind: 'named', profile };
  } catch (error) {
    if (error instanceof GraphApiFailure) {
      return readOfFailure(error);
    }
    throw error;
  }
};

/** The contact's name for a profile: the name, else the `@handle`. */
export const contactNameFor = (profile: MetaProfile): string | null =>
  profile.name ?? (profile.username === null ? null : `@${profile.username}`);

/**
 * Whether a contact still has the name it was created with when Meta gave none:
 * nothing, or the identity value the router falls back on. A contact an agent
 * renamed, or Meta named, is left alone.
 */
export const hasPlaceholderName = (contactName: string, identityValue: string): boolean =>
  contactName.trim() === '' || contactName === identityValue;
