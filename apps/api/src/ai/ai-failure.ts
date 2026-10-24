import type { AiRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An AI settings change refused by a rule rather than by a permission (M7-01,
 * M7-02). The same shape as `domains/domains-failure.ts`: the admin screen
 * picks its sentence from `reason`; the messages below are for the log and
 * for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<AiRefusal, number>> = {
  'locked-by-environment': HttpStatus.CONFLICT,
  'unknown-provider': HttpStatus.NOT_FOUND,
  'unknown-kind': HttpStatus.BAD_REQUEST,
  'unknown-model': HttpStatus.BAD_REQUEST,
  'credential-required': HttpStatus.BAD_REQUEST,
  'embedding-key-required': HttpStatus.BAD_REQUEST,
  'transcription-key-required': HttpStatus.BAD_REQUEST,
  'oauth-unsupported': HttpStatus.BAD_REQUEST,
  'provider-in-use': HttpStatus.CONFLICT,
  'discovery-failed': HttpStatus.CONFLICT,
  'reembed-not-confirmed': HttpStatus.CONFLICT,
  'https-required': HttpStatus.BAD_REQUEST,
  'destination-blocked': HttpStatus.BAD_REQUEST,
};

const MESSAGE_BY_REASON: Readonly<Record<AiRefusal, string>> = {
  'locked-by-environment': 'This setting is pinned by the environment and cannot be changed here',
  'unknown-provider': 'There is no AI provider with that id',
  'unknown-kind': 'There is no AI provider of that kind',
  'unknown-model': 'The provider does not offer that model',
  'credential-required':
    'This provider needs a credential; a stored one is only used with the kind and address it was saved for',
  'embedding-key-required':
    'The stored embeddings key is only used with the address it was saved for; type it again',
  'transcription-key-required':
    'The stored transcription key is only used with the endpoint it was saved for; type it again',
  'oauth-unsupported': 'This kind of provider does not accept subscription credentials',
  'provider-in-use': 'The default model or a brand still uses this provider',
  'discovery-failed': 'The provider could not be asked for its models',
  'reembed-not-confirmed':
    'Changing the embedding model re-embeds every knowledge chunk; confirm it to go ahead',
  'https-required': 'Use https://; model endpoints are not reached over plain HTTP',
  'destination-blocked':
    'That address is private, loopback or link-local; allow its range in OUTBOUND_ALLOW_CIDRS to use it',
};

export class AiFailure extends HttpException {
  readonly reason: AiRefusal;
  /** The request field a form draws the refusal on, when it is about one. */
  readonly field: string | undefined;

  constructor(reason: AiRefusal, field?: string) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'AiFailure';
    this.reason = reason;
    this.field = field;
  }
}
