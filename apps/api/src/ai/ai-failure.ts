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
  'oauth-unsupported': HttpStatus.BAD_REQUEST,
  'provider-in-use': HttpStatus.CONFLICT,
  'discovery-failed': HttpStatus.CONFLICT,
  'reembed-not-confirmed': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<AiRefusal, string>> = {
  'locked-by-environment': 'This setting is pinned by the environment and cannot be changed here',
  'unknown-provider': 'There is no AI provider with that id',
  'unknown-kind': 'There is no AI provider of that kind',
  'unknown-model': 'The provider does not offer that model',
  'credential-required': 'This provider needs a credential',
  'oauth-unsupported': 'This kind of provider does not accept subscription credentials',
  'provider-in-use': 'The default model or a brand still uses this provider',
  'discovery-failed': 'The provider could not be asked for its models',
  'reembed-not-confirmed':
    'Changing the embedding model re-embeds every knowledge chunk; confirm it to go ahead',
};

export class AiFailure extends HttpException {
  readonly reason: AiRefusal;

  constructor(reason: AiRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'AiFailure';
    this.reason = reason;
  }
}
