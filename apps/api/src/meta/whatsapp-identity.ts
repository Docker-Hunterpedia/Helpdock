import {
  GRAPH_IDENTITY_FIELDS,
  GraphApiFailure,
  graphIdentityName,
  graphIdentitySchema,
  parseGraph,
} from '@helpdock/channels';
import { z } from 'zod';
import type { AccountGraph } from './account-graph.js';
import { readTokenFacts } from './token-facts.js';

/**
 * Identifying a WhatsApp number (M10-07). The Connect dialog asks for the phone
 * number id and the token, and nothing else, but Meta keeps the webhook
 * subscription on the business account (WABA) that owns the number: the number's
 * own node answers an unsupported-edge error for `subscribed_apps`. So
 * connecting resolves the business account from what the token can see, and the
 * row keeps it in `waba_id`.
 *
 * Kept in one function so the order of the calls is in one place to read and to
 * check against Meta.
 */

/** A system user's token is granted on the business accounts it was assigned. */
const MANAGEMENT_SCOPE = 'whatsapp_business_management';
const MESSAGING_SCOPE = 'whatsapp_business_messaging';

/** A token that names more business accounts than this is not asked about all of them. */
const MAX_BUSINESS_ACCOUNTS = 25;

/** One page of a business account's numbers; Meta allows far fewer on one account. */
const NUMBERS_PAGE_SIZE = 100;

const phoneNumbersSchema = z.looseObject({
  data: z.array(
    z.looseObject({ id: z.union([z.string().min(1), z.number().int()]).transform(String) }),
  ),
});

export const NO_BUSINESS_ACCOUNT_DETAIL =
  'The token cannot see a WhatsApp business account that owns this number. Assign the business account to the system user, then generate the token again.';

export type WhatsAppIdentity =
  | {
      readonly ok: true;
      /** The verified business name, or the number's id when Meta gives none. */
      readonly name: string;
      readonly displayPhone: string | null;
      /** Null for a system-user token, which does not expire. */
      readonly expiresAt: Date | null;
      /** The business account whose `/phone_numbers` lists the number. */
      readonly wabaId: string;
    }
  | {
      readonly ok: false;
      /**
       * `token-invalid`: Graph calls the token invalid. `token-other-account`: it
       * opens another number, or no business account that owns this one.
       */
      readonly refusal: 'token-invalid' | 'token-other-account';
      readonly detail: string | null;
    };

/**
 * Reads the number, checks the token and finds the business account that owns
 * it:
 *
 * 1. `GET /{phone_number_id}` says what the number is and that the token opens it.
 * 2. `GET /debug_token` says the token is good, until when, and which business
 *    accounts it was granted on (`granular_scopes` of `whatsapp_business_management`,
 *    else `whatsapp_business_messaging`).
 * 3. `GET /{waba_id}/phone_numbers` for each of them; the one that lists the
 *    number is the business account.
 *
 * A token with no business account that lists the number is refused as
 * `token-other-account`: it can read the number but could not subscribe the
 * app, and the operator's fix is to assign the business account to the system
 * user. A Graph failure that is no answer (a 5xx, a limit, a dead token) is
 * thrown for the caller to map.
 */
export const identifyWhatsApp = async (
  graph: Pick<AccountGraph, 'get' | 'debugToken'>,
  phoneNumberId: string,
): Promise<WhatsAppIdentity> => {
  const number = parseGraph(
    graphIdentitySchema,
    await graph.get(`/${phoneNumberId}`, { fields: GRAPH_IDENTITY_FIELDS.whatsapp }),
    'to the account read',
  );
  if (number.id !== phoneNumberId) {
    return { ok: false, refusal: 'token-other-account', detail: null };
  }

  const facts = await readTokenFacts(graph);
  if (facts.valid === false) {
    return { ok: false, refusal: 'token-invalid', detail: facts.detail };
  }
  // Without this answer there is no telling the token has no business account, so it is Graph that failed.
  if (facts.valid === null && facts.targets.size === 0) {
    throw new GraphApiFailure('retry', 'Graph did not answer the token check');
  }

  const managed = facts.targets.get(MANAGEMENT_SCOPE) ?? [];
  const candidates = managed.length > 0 ? managed : (facts.targets.get(MESSAGING_SCOPE) ?? []);
  const wabaId = await findBusinessAccount(graph, phoneNumberId, candidates);
  if (wabaId === null) {
    return { ok: false, refusal: 'token-other-account', detail: NO_BUSINESS_ACCOUNT_DETAIL };
  }

  return {
    ok: true,
    name: graphIdentityName(number),
    displayPhone: number.display_phone_number ?? null,
    expiresAt: facts.expiresAt,
    wabaId,
  };
};

/**
 * The first candidate whose numbers include this one. A business account the
 * token may not list is skipped, because a system user is often assigned several
 * and only one holds the number; a failure that says nothing about that account
 * is thrown.
 */
const findBusinessAccount = async (
  graph: Pick<AccountGraph, 'get'>,
  phoneNumberId: string,
  candidates: readonly string[],
): Promise<string | null> => {
  for (const wabaId of candidates.slice(0, MAX_BUSINESS_ACCOUNTS)) {
    try {
      const { data } = parseGraph(
        phoneNumbersSchema,
        await graph.get(`/${wabaId}/phone_numbers`, { fields: 'id', limit: NUMBERS_PAGE_SIZE }),
        'to the business account read',
      );
      if (data.some((candidate) => candidate.id === phoneNumberId)) {
        return wabaId;
      }
    } catch (error) {
      if (!(error instanceof GraphApiFailure) || !refusesThisAccountOnly(error)) {
        throw error;
      }
    }
  }

  return null;
};

/** Graph answered, and the answer is about this business account rather than about the token or Graph. */
const refusesThisAccountOnly = (error: GraphApiFailure): boolean =>
  (error.kind === 'permission' || error.kind === 'permanent') &&
  error.code !== null &&
  error.reason === null;
