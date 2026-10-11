import {
  GraphApiFailure,
  graphDebugTokenSchema,
  parseGraph,
  redactToken,
} from '@helpdock/channels';
import { META_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { z } from 'zod';
import type { AccountGraph } from './graph-factory.js';

/**
 * What `GET /debug_token` says of a token (M10-07): whether it works, when it
 * ends, and which objects it was granted on. The Connect dialog, the status
 * panel and the WhatsApp business-account lookup all ask the same question, so
 * the answer is read in one place.
 */
export interface TokenFacts {
  /** Null when Graph could not be asked: a token that works is not refused for that. */
  readonly valid: boolean | null;
  /** Null for a token that does not expire, and for one Graph did not date. */
  readonly expiresAt: Date | null;
  /** Graph's reason for a token it calls invalid, with the token taken out. */
  readonly detail: string | null;
  /**
   * The ids the token was granted on, per scope (`granular_scopes`): for a
   * system user's WhatsApp token these are the business accounts it was
   * assigned. Empty for a token that carries none.
   */
  readonly targets: ReadonlyMap<string, readonly string[]>;
}

const idSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

/** `granular_scopes` sits beside the fields the shared schema reads, which it does not know. */
const grantedSchema = z.looseObject({
  data: z.looseObject({
    granular_scopes: z
      .array(z.looseObject({ scope: z.string(), target_ids: z.array(idSchema).optional() }))
      .optional(),
  }),
});

/**
 * Asks Graph about the token. A token Graph calls dead is thrown, because that
 * is the answer the caller wanted; any other failure only means the question
 * went unanswered, and the facts say so with `valid: null`.
 */
export const readTokenFacts = async (
  graph: Pick<AccountGraph, 'debugToken'>,
): Promise<TokenFacts> => {
  try {
    const body = await graph.debugToken();
    const { data } = parseGraph(graphDebugTokenSchema, body, 'to the token check');
    const granted = grantedSchema.safeParse(body);

    return {
      valid: data.is_valid ?? null,
      // Zero is Graph's word for a token that does not expire.
      expiresAt:
        data.expires_at === undefined || data.expires_at === 0
          ? null
          : new Date(data.expires_at * 1_000),
      detail:
        data.error?.message === undefined
          ? null
          : redactToken(data.error.message).slice(0, META_ERROR_MAX_LENGTH),
      targets: granted.success
        ? targetsByScope(granted.data.data.granular_scopes ?? [])
        : new Map(),
    };
  } catch (error) {
    if (error instanceof GraphApiFailure && error.kind === 'token_dead') {
      throw error;
    }

    return { valid: null, expiresAt: null, detail: null, targets: new Map() };
  }
};

const targetsByScope = (
  scopes: readonly {
    readonly scope: string;
    readonly target_ids?: readonly string[] | undefined;
  }[],
): ReadonlyMap<string, readonly string[]> => {
  const targets = new Map<string, string[]>();
  for (const { scope, target_ids } of scopes) {
    const known = targets.get(scope) ?? [];
    targets.set(scope, [...known, ...(target_ids ?? []).filter((id) => !known.includes(id))]);
  }

  return targets;
};
