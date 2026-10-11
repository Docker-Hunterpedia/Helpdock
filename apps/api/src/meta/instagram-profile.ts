import {
  GraphApiFailure,
  type GraphClient,
  graphIdentitySchema,
  parseGraph,
} from '@helpdock/channels';
import type { MetaConversation as MetaConversationRow } from '@helpdock/db';

/**
 * The one Graph call the Instagram inbound service makes while it files a
 * message (M10-05, DOMAIN-RULES §4.7): `GET /{igsid}?fields=name,username` on
 * the Instagram root, which Instagram allows once the customer has written to
 * the account. The webhook otherwise never calls Graph; a name is worth one
 * short read, because an `@handle` is what an agent recognises a customer by.
 *
 * It is never worth the message. Every failure ends in "no profile", and the
 * read is cut off after {@link INSTAGRAM_PROFILE_TIMEOUT_MS} because Meta
 * waits seconds for the webhook's answer and unsubscribes the app after an
 * hour of slow ones (ADR 0025, 4).
 */

export const INSTAGRAM_PROFILE_FIELDS = 'name,username';
export const INSTAGRAM_PROFILE_TIMEOUT_MS = 3_000;

export interface InstagramProfile {
  readonly name: string | null;
  readonly username: string | null;
}

export type InstagramProfileResult =
  | { readonly ok: true; readonly profile: InstagramProfile }
  | {
      readonly ok: false;
      /** The Graph error class, `timeout`, or `error`; never a message that could quote a token. */
      readonly reason: string;
      readonly code: number | null;
    };

/**
 * Whether a conversation still lacks the profile: it is new, or no earlier
 * message got one. A conversation that has a name or an `@handle` is never
 * read again, so a successful read happens once per conversation; one that
 * failed (the token, Meta, the network) is tried again on the customer's next
 * message, at most one short call per message.
 */
export const needsProfile = (
  conversation: Pick<MetaConversationRow, 'profileName' | 'username'> | undefined,
): boolean =>
  conversation === undefined ||
  (conversation.profileName === null && conversation.username === null);

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GraphApiFailure('retry', 'timeout')), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // The call that lost the race still settles; nobody is left to hear it fail.
    work.catch(() => undefined);
  }
};

const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();

export const readInstagramProfile = async (input: {
  readonly graph: Pick<GraphClient, 'get'>;
  readonly token: string;
  readonly igsid: string;
  readonly timeoutMs?: number;
}): Promise<InstagramProfileResult> => {
  const { graph, token, igsid, timeoutMs = INSTAGRAM_PROFILE_TIMEOUT_MS } = input;
  try {
    const body = await withTimeout(
      graph.get(`/${igsid}`, {
        token,
        api: 'instagram',
        query: { fields: INSTAGRAM_PROFILE_FIELDS },
      }),
      timeoutMs,
    );
    const identity = parseGraph(graphIdentitySchema, body, 'an Instagram profile', token);
    const profile = { name: blankToNull(identity.name), username: blankToNull(identity.username) };

    return profile.name === null && profile.username === null
      ? { ok: false, reason: 'empty', code: null }
      : { ok: true, profile };
  } catch (error) {
    return error instanceof GraphApiFailure
      ? {
          ok: false,
          reason: error.detail === 'timeout' ? 'timeout' : error.kind,
          code: error.code,
        }
      : { ok: false, reason: 'error', code: null };
  }
};
