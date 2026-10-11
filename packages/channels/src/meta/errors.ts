import { META_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * What a refusal from the Graph API means for Helpdock (ADR 0025, brief §1.1).
 * The table is data so the unit test can hold every code to its class, and the
 * `meta.send` job, the health job and the admin screens read one answer.
 *
 * | Kind | What the caller does |
 * |---|---|
 * | `retry` | ask again later: Graph or the network failed, not the request |
 * | `rate_limited` | ask again later, and for the pair limit (`131056`) wait |
 * | `window_closed` | the reply window is shut; no retry fixes it |
 * | `token_dead` | the token is no longer valid; an Admin pastes a new one |
 * | `permission` | the token lacks, or lost, a permission; an Admin fixes it in Meta |
 * | `account_restricted` | Meta restricted the number, Page or account; an Admin fixes it in Meta |
 * | `permanent` | this request is refused for good: a parameter, a recipient, a template |
 */
export type GraphErrorKind =
  | 'retry'
  | 'rate_limited'
  | 'window_closed'
  | 'token_dead'
  | 'permission'
  | 'account_restricted'
  | 'permanent';

/** Error codes and the class each belongs to. Codes absent here are `permanent`. */
export const GRAPH_ERROR_CODES: Readonly<Record<GraphErrorKind, readonly number[]>> = Object.freeze(
  {
    // 190 expired or invalid access token; 102 session invalid; 463 and 467 are
    // the sub-codes of 190 Graph sometimes reports as the code; 0 "could not
    // authenticate the app user".
    token_dead: [190, 102, 463, 467, 0],
    // 3 capability missing; 10 permission denied (but see WINDOW_CLOSED_SUBCODE);
    // 200-299 permission missing or removed.
    permission: [3, 10],
    // 131047 WhatsApp: more than 24 hours since the customer last wrote.
    window_closed: [131_047],
    // 4 app limit, 17 user limit, 32 Page limit, 613 call limit, 130429 WhatsApp
    // throughput, 131056 pair limit (one message per user per six seconds),
    // 80007 WABA limit, 131057 maintenance during a throughput upgrade.
    rate_limited: [4, 17, 32, 613, 130_429, 131_056, 80_007, 131_057],
    // 1 and 2 are Graph's "unknown" and "service temporarily unavailable";
    // 131000 unknown and 131016 service unavailable are WhatsApp's.
    retry: [1, 2, 131_000, 131_016],
    // 368 temporarily blocked for policy violations; 131031 account locked;
    // 133010 number not registered; 131042 payment method problem; 130497
    // business restricted from messaging users in this country.
    account_restricted: [368, 131_031, 133_010, 131_042, 130_497],
    permanent: [],
  },
);

/** The sub-code Messenger and Instagram send with code `10` for a closed window. */
export const WINDOW_CLOSED_SUBCODE = 2_018_278;

/** Codes 200 through 299 are all "a permission is missing". */
const PERMISSION_RANGE = { from: 200, to: 299 } as const;

/** What Graph said, taken from an error body. Every field is optional on the wire. */
export interface GraphErrorFacts {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly message: string | null;
}

const errorBodySchema = z.looseObject({
  error: z.looseObject({
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    message: z.string().optional(),
    // WhatsApp puts the useful sentence here.
    error_data: z.looseObject({ details: z.string().optional() }).optional(),
  }),
});

/** The `errors[]` of a WhatsApp status or message webhook. */
export const graphWebhookErrorSchema = z.looseObject({
  code: z.number().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  error_data: z.looseObject({ details: z.string().optional() }).optional(),
});

/** Reads the facts out of a parsed response body, or null when it is not an error body. */
export const graphErrorFacts = (body: unknown): GraphErrorFacts | null => {
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const { error } = parsed.data;

  return {
    code: error.code ?? null,
    subcode: error.error_subcode ?? null,
    message: error.error_data?.details ?? error.message ?? null,
  };
};

/**
 * The class of one error code. Pure, so the webhook can classify the `errors[]`
 * of a failed status with the same table a failed send uses.
 */
export const classifyGraphCode = (code: number | null, subcode: number | null): GraphErrorKind => {
  if (code === null) {
    return 'permanent';
  }
  if (code === 10 && subcode === WINDOW_CLOSED_SUBCODE) {
    return 'window_closed';
  }
  if (code >= PERMISSION_RANGE.from && code <= PERMISSION_RANGE.to) {
    return 'permission';
  }
  for (const kind of Object.keys(GRAPH_ERROR_CODES) as GraphErrorKind[]) {
    if (GRAPH_ERROR_CODES[kind].includes(code)) {
      return kind;
    }
  }

  return 'permanent';
};

/** Kinds for which asking again will not help. */
const PERMANENT_KINDS: ReadonlySet<GraphErrorKind> = new Set([
  'window_closed',
  'token_dead',
  'permission',
  'account_restricted',
  'permanent',
]);

/** Whether asking again would be pointless. A 429 or a 5xx is not permanent. */
export const isPermanentKind = (kind: GraphErrorKind): boolean => PERMANENT_KINDS.has(kind);

export type GraphFailureReason = 'transport' | 'too-large' | 'host-not-allowed' | 'blocked';

/** A refused or unreachable Graph call, with words fit for an Admin to read. */
export class GraphApiFailure extends Error {
  readonly kind: GraphErrorKind;
  /** Graph's error code, or null when it gave none (a transport failure, an empty 5xx). */
  readonly code: number | null;
  readonly subcode: number | null;
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** Graph's own words with the token taken out, short enough for `last_error`. Never the token. */
  readonly detail: string;
  /**
   * Graph said no to this request for good — the window is shut, the token is
   * dead, the recipient is gone — so asking again will not help. A rate limit
   * or a 5xx is not permanent.
   */
  readonly permanent: boolean;
  /**
   * Why the call never became a Graph answer, when it did not: the network
   * failed (`transport`), a download went past its size cap (`too-large`), the
   * host is not Meta's (`host-not-allowed`) or the SSRF-safe client refused the
   * destination (`blocked`). Null when Graph itself answered.
   */
  readonly reason: GraphFailureReason | null;

  constructor(
    kind: GraphErrorKind,
    detail: string,
    facts: {
      readonly code?: number | null;
      readonly subcode?: number | null;
      readonly status?: number;
      readonly reason?: GraphFailureReason;
    } = {},
  ) {
    super(detail);
    this.name = 'GraphApiFailure';
    this.kind = kind;
    this.detail = detail;
    this.code = facts.code ?? null;
    this.subcode = facts.subcode ?? null;
    this.status = facts.status ?? 0;
    this.permanent = isPermanentKind(kind);
    this.reason = facts.reason ?? null;
  }
}

/**
 * The text of an error for a person: the code and Graph's sentence, cut to what
 * `last_error` keeps. The token is removed first, wherever Graph or the
 * transport chose to quote it.
 */
const BEARER = /\bBearer\s+[^\s"',;]+/gi;
const ACCESS_TOKEN_PARAM = /\b(access_token|input_token|client_secret|appsecret_proof)=[^&\s"']+/gi;

export const redactToken = (text: string, ...tokens: readonly (string | undefined)[]): string => {
  let clean = text.replace(BEARER, 'Bearer <token>').replace(ACCESS_TOKEN_PARAM, '$1=<token>');
  for (const token of tokens) {
    if (token !== undefined && token.length >= 8) {
      clean = clean.split(token).join('<token>');
    }
  }

  return clean;
};

const truncate = (text: string): string =>
  text.length <= META_ERROR_MAX_LENGTH ? text : `${text.slice(0, META_ERROR_MAX_LENGTH - 1)}…`;

/**
 * `190: Invalid OAuth access token`, or `10/2018278: …` with a sub-code, or
 * `HTTP 502: …` when Graph gave no code: the shape of Telegram's `400: …`.
 */
export const describeGraphError = (
  facts: GraphErrorFacts,
  status: number,
  ...tokens: readonly (string | undefined)[]
): string => {
  const label =
    facts.code === null
      ? `HTTP ${String(status)}`
      : facts.subcode === null
        ? String(facts.code)
        : `${String(facts.code)}/${String(facts.subcode)}`;

  return truncate(redactToken(`${label}: ${facts.message ?? 'Graph gave no reason'}`, ...tokens));
};

/**
 * An HTTP answer that was not a success, as a {@link GraphApiFailure}. The body
 * is whatever the response held, parsed as JSON when it was JSON and `null`
 * when it was not.
 */
export const classifyGraphError = (
  status: number,
  body: unknown,
  ...tokens: readonly (string | undefined)[]
): GraphApiFailure => {
  const facts = graphErrorFacts(body) ?? { code: null, subcode: null, message: null };
  const kind = kindForAnswer(status, facts);

  return new GraphApiFailure(kind, describeGraphError(facts, status, ...tokens), {
    code: facts.code,
    subcode: facts.subcode,
    status,
  });
};

/**
 * A 5xx is Graph failing whatever it quotes. Otherwise the code decides when
 * Graph gave one, and the HTTP status when it did not: a 429 is a limit, a 401
 * a token, a 403 a permission.
 */
const kindForAnswer = (status: number, facts: GraphErrorFacts): GraphErrorKind => {
  if (status >= 500) {
    return 'retry';
  }
  if (facts.code !== null) {
    return classifyGraphCode(facts.code, facts.subcode);
  }
  switch (status) {
    case 401:
      return 'token_dead';
    case 403:
      return 'permission';
    case 429:
      return 'rate_limited';
    default:
      return 'permanent';
  }
};
