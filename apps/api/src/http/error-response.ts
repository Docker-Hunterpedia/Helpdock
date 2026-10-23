import { TenantContextError } from '@helpdock/db';
import type {
  AiRefusal,
  AssistRefusal,
  AuthErrorBody,
  ChannelsRefusal,
  ContactRefusal,
  DomainsRefusal,
  ErrorCode,
  ErrorResponse,
  FieldError,
  HcRefusal,
  IdentityProblem,
  KnowledgeRefusal,
  MetaRefusal,
  MetaRefusalDetails,
  PasskeysRefusal,
  SetupRefusal,
  SsoRefusal,
  StaffRefusal,
  TelegramRefusal,
  TicketingRefusal,
  TicketLifecycleRefusal,
  WebhooksRefusal,
  WidgetErrorCode,
} from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { AiFailure } from '../ai/ai-failure.js';
import { AssistFailure } from '../assist/assist-failure.js';
import { AuthFailure } from '../auth/auth-failure.js';
import { PasskeysFailure } from '../auth/passkeys/passkeys-failure.js';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { ChannelsFailure } from '../channels/channels-failure.js';
import { ContactFailure } from '../contacts/contact-failure.js';
import { IdentityContentionError } from '../contacts/identity.js';
import { DomainsFailure } from '../domains/domains-failure.js';
import { HelpCenterFailure } from '../help-center/help-center-failure.js';
import { SetupFailure, SetupThrottled } from '../install/setup-failure.js';
import { KnowledgeFailure } from '../knowledge/knowledge-failure.js';
import { MetaFailure } from '../meta/meta-failure.js';
import { SsoFailure } from '../sso/sso-failure.js';
import { StaffFailure } from '../staff/staff-failure.js';
import { TelegramFailure } from '../telegram/telegram-failure.js';
import { TenantScopeError } from '../tenant/tenant-scope.js';
import { TicketLifecycleFailure } from '../tickets/lifecycle/lifecycle-failure.js';
import { WebhooksFailure } from '../webhooks/webhooks-failure.js';
import { WidgetFailure } from '../widget/widget-failure.js';

/**
 * How a thrown thing becomes a response. Split from the filter so it can be
 * tested without an execution context, and so there is one place to read when
 * asking "what does the client learn from this failure?".
 *
 * The rule: a client learns the status, a stable code, a message written for
 * it, and the request id. Everything else — the cause, the stack, the SQL — goes
 * to the log under that same id.
 */

export interface MappedError {
  readonly status: number;
  /** Seconds for the `Retry-After` header, when the refusal is worth retrying. */
  readonly retryAfter?: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly fields?: readonly FieldError[];
  /** Only on an auth failure, sign-in or step-up; see `auth/auth-failure.ts`. */
  readonly auth?: AuthErrorBody;
  /** Only on a refused staff action; see `staff/staff-failure.ts`. */
  readonly staff?: StaffRefusal;
  /** Only on a refused contact action; see `contacts/contact-failure.ts`. */
  readonly contact?: { readonly reason: ContactRefusal; readonly problem?: IdentityProblem };
  /** Only on a refused ticketing-settings action; see `brands/ticketing-failure.ts`. */
  readonly ticketing?: TicketingRefusal;
  /** Only on a transition §2.2 has no row for, or a close M14-17's gate stops; see `tickets/lifecycle/lifecycle-failure.ts`. */
  readonly lifecycle?: {
    readonly reason: TicketLifecycleRefusal;
    readonly fields?: readonly string[];
  };
  /** Only on a refused wizard step; see `install/setup-failure.ts`. */
  readonly setup?: SetupRefusal;
  /** Only on a refused mailbox action; see `channels/channels-failure.ts`. */
  readonly channels?: ChannelsRefusal;
  /** Only on a refused custom-domain action; see `domains/domains-failure.ts`. */
  readonly domains?: DomainsRefusal;
  /** Only on a refused move of the install's passkeys; see `auth/passkeys/passkeys-failure.ts`. */
  readonly passkeys?: PasskeysRefusal;
  /** Only on a refused Telegram bot action; see `telegram/telegram-failure.ts`. */
  readonly telegram?: TelegramRefusal;
  /** Only on a refused Meta channel action; see `meta/meta-failure.ts`. */
  readonly meta?: { readonly reason: MetaRefusal; readonly details?: MetaRefusalDetails };
  /** Only on a refused widget request; see `widget/widget-failure.ts`. */
  readonly widget?: WidgetErrorCode;
  /** Only on a refused help center change; see `help-center/help-center-failure.ts`. */
  readonly helpCenter?: HcRefusal;
  /** Only on a refused AI settings change; see `ai/ai-failure.ts`. */
  readonly ai?: AiRefusal;
  /** Only on a refused assist request; see `assist/assist-failure.ts`. */
  readonly assist?: AssistRefusal;
  /** Only on a refused knowledge source action; see `knowledge/knowledge-failure.ts`. */
  readonly knowledge?: KnowledgeRefusal;
  /** Only on a refused webhook endpoint; see `webhooks/webhooks-failure.ts`. */
  readonly webhooks?: { readonly reason: WebhooksRefusal; readonly address?: string };
  /** Only on a refused SSO connection save; see `sso/sso-failure.ts`. */
  readonly sso?: { readonly reason: SsoRefusal; readonly domains?: readonly string[] };
  /** True when the log line should carry the whole error, not just its message. */
  readonly unexpected: boolean;
}

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'validation_failed',
  [HttpStatus.UNAUTHORIZED]: 'unauthenticated',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  // A brand in its deletion grace (M8-07): `BrandGoneGuard`, and the API key resolver.
  [HttpStatus.GONE]: 'gone',
  // M8-02: an Idempotency-Key reused with a different request.
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
};

/** `body.email`, `params.brandId`: the path as the request carried it. */
const fieldErrorsOf = (error: ZodError): readonly FieldError[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

const zodErrorIn = (exception: ZodValidationException): ZodError | undefined => {
  const error = exception.getZodError();
  return error instanceof ZodError ? error : undefined;
};

export const mapError = (error: unknown): MappedError => {
  // A response that fails its own output schema is a bug in the api, not in the
  // request, and the failing field names a column: 500, and the detail is for
  // the log alone.
  if (error instanceof ZodSerializationException) {
    return internalError();
  }

  if (error instanceof ZodValidationException || error instanceof ZodError) {
    const zodError = error instanceof ZodError ? error : zodErrorIn(error);
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'validation_failed',
      message: 'The request did not match the expected shape',
      ...(zodError === undefined ? {} : { fields: fieldErrorsOf(zodError) }),
      unexpected: false,
    };
  }

  // Before the generic `HttpException` branch, which would drop the detail the
  // sign-in screens read.
  if (error instanceof AuthFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'unauthenticated',
      message: error.message,
      auth: error.auth,
      unexpected: false,
    };
  }

  // Before the generic branch too, for the same reason: the staff screen reads
  // the refusal, and `HttpException` would drop it.
  if (error instanceof StaffFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'forbidden',
      message: error.message,
      staff: error.reason,
      unexpected: false,
    };
  }

  if (error instanceof ContactFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      contact: {
        reason: error.reason,
        ...(error.problem === undefined ? {} : { problem: error.problem }),
      },
      unexpected: false,
    };
  }

  // Before the generic branch, for the reason the ones above give.
  if (error instanceof TicketingFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'forbidden',
      message: error.message,
      ticketing: error.reason,
      unexpected: false,
    };
  }

  // Before the generic branch, for the reason the ones above give.
  if (error instanceof TicketLifecycleFailure) {
    return {
      status: error.getStatus(),
      code: 'conflict',
      message: error.message,
      lifecycle: {
        reason: error.reason,
        ...(error.fields.length === 0 ? {} : { fields: [...error.fields] }),
      },
      unexpected: false,
    };
  }

  // Before the generic branch, for the reason the ones above give.
  if (error instanceof SetupFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'forbidden',
      message: error.message,
      setup: error.reason,
      ...(error.reason === 'smtp-password-required'
        ? { fields: [{ path: 'body.password', message: error.message }] }
        : {}),
      unexpected: false,
    };
  }

  if (error instanceof SetupThrottled) {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      retryAfter: error.retryAfter,
      code: 'rate_limited',
      message: error.message,
      unexpected: false,
    };
  }

  // M2-08. Before the generic branch, for the reason the ones above give.
  if (error instanceof ChannelsFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      channels: error.reason,
      unexpected: false,
    };
  }

  // M6-05. Before the generic branch, for the reason the ones above give.
  if (error instanceof TelegramFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      telegram: error.reason,
      unexpected: false,
    };
  }

  // M10-02. Before the generic branch, for the reason the ones above give.
  if (error instanceof MetaFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      meta: {
        reason: error.reason,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      unexpected: false,
    };
  }

  // M5-07. Before the generic branch, for the reason the ones above give.
  if (error instanceof DomainsFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      domains: error.reason,
      unexpected: false,
    };
  }

  if (error instanceof PasskeysFailure) {
    return {
      status: error.getStatus(),
      code: 'conflict',
      message: error.message,
      passkeys: error.reason,
      unexpected: false,
    };
  }

  if (error instanceof WebhooksFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'validation_failed',
      message: error.message,
      webhooks: {
        reason: error.reason,
        ...(error.address === undefined ? {} : { address: error.address }),
      },
      unexpected: false,
    };
  }

  if (error instanceof SsoFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      sso: {
        reason: error.reason,
        ...(error.domains === undefined ? {} : { domains: error.domains }),
      },
      unexpected: false,
    };
  }

  // M4. Before the generic branch, for the reason the ones above give.
  if (error instanceof WidgetFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'forbidden',
      message: error.message,
      widget: error.reason,
      unexpected: false,
    };
  }

  // M5-01. Before the generic branch, for the reason the ones above give.
  if (error instanceof HelpCenterFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      helpCenter: error.reason,
      unexpected: false,
    };
  }

  // M7. Before the generic branch, for the reason the ones above give.
  if (error instanceof AiFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      ai: error.reason,
      unexpected: false,
    };
  }

  // M7-05. A provider failure is a 502 the agent can retry, not an internal error.
  if (error instanceof AssistFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'internal_error',
      message: error.message,
      assist: error.reason,
      unexpected: false,
    };
  }

  if (error instanceof KnowledgeFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'conflict',
      message: error.message,
      knowledge: error.reason,
      unexpected: false,
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= HttpStatus.INTERNAL_SERVER_ERROR
      ? internalError()
      : {
          status,
          code: CODE_BY_STATUS[status] ?? 'internal_error',
          message: error.message,
          unexpected: false,
        };
  }

  // Both name a context the caller built wrongly, and neither message carries a
  // value: `TenantContextError` names the field, `TenantScopeError` the reason.
  if (error instanceof TenantContextError || error instanceof TenantScopeError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'validation_failed',
      message: error.message,
      unexpected: false,
    };
  }

  // The write lost a race on its rows repeatedly; nothing was saved and a retry will do.
  if (error instanceof IdentityContentionError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'unavailable',
      message: 'The record is being changed elsewhere. Try again in a moment.',
      retryAfter: IDENTITY_CONTENTION_RETRY_AFTER_SECONDS,
      unexpected: false,
    };
  }

  return internalError();
};

const IDENTITY_CONTENTION_RETRY_AFTER_SECONDS = 1;

const internalError = (): MappedError => ({
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'internal_error',
  // Deliberately fixed: an unexpected error's message may quote a row, a query
  // or a connection string.
  message: 'The request could not be completed',
  unexpected: true,
});

export const errorBody = (mapped: MappedError, requestId: string): ErrorResponse => ({
  error: {
    code: mapped.code,
    message: mapped.message,
    requestId,
    ...(mapped.fields === undefined ? {} : { fields: [...mapped.fields] }),
    ...(mapped.auth === undefined ? {} : { auth: mapped.auth }),
    ...(mapped.staff === undefined ? {} : { staff: { reason: mapped.staff } }),
    ...(mapped.contact === undefined ? {} : { contact: mapped.contact }),
    ...(mapped.ticketing === undefined ? {} : { ticketing: { reason: mapped.ticketing } }),
    ...(mapped.lifecycle === undefined
      ? {}
      : {
          lifecycle: {
            reason: mapped.lifecycle.reason,
            ...(mapped.lifecycle.fields === undefined
              ? {}
              : { fields: [...mapped.lifecycle.fields] }),
          },
        }),
    ...(mapped.setup === undefined ? {} : { setup: { reason: mapped.setup } }),
    ...(mapped.channels === undefined ? {} : { channels: { reason: mapped.channels } }),
    ...(mapped.domains === undefined ? {} : { domains: { reason: mapped.domains } }),
    ...(mapped.passkeys === undefined ? {} : { passkeys: { reason: mapped.passkeys } }),
    ...(mapped.telegram === undefined ? {} : { telegram: { reason: mapped.telegram } }),
    ...(mapped.meta === undefined ? {} : { meta: mapped.meta }),
    ...(mapped.widget === undefined ? {} : { widget: { reason: mapped.widget } }),
    ...(mapped.helpCenter === undefined ? {} : { helpCenter: { reason: mapped.helpCenter } }),
    ...(mapped.ai === undefined ? {} : { ai: { reason: mapped.ai } }),
    ...(mapped.knowledge === undefined ? {} : { knowledge: { reason: mapped.knowledge } }),
    ...(mapped.assist === undefined ? {} : { assist: { reason: mapped.assist } }),
    ...(mapped.webhooks === undefined ? {} : { webhooks: mapped.webhooks }),
    ...(mapped.sso === undefined
      ? {}
      : {
          sso: {
            reason: mapped.sso.reason,
            ...(mapped.sso.domains === undefined ? {} : { domains: [...mapped.sso.domains] }),
          },
        }),
  },
});
