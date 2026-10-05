import type { KnowledgeRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A knowledge request refused by a rule rather than by a permission (M7-03),
 * the shape of `ai/ai-failure.ts`: the admin picks its sentence from `reason`.
 */

const STATUS_BY_REASON: Readonly<Record<KnowledgeRefusal, number>> = {
  'article-source-fixed': HttpStatus.CONFLICT,
  'invalid-config': HttpStatus.BAD_REQUEST,
  'not-a-file': HttpStatus.CONFLICT,
  'upload-missing': HttpStatus.CONFLICT,
  'rendering-disabled': HttpStatus.BAD_REQUEST,
  'oauth-not-configured': HttpStatus.CONFLICT,
  'oauth-state-invalid': HttpStatus.BAD_REQUEST,
  'not-connected': HttpStatus.CONFLICT,
  'connection-refused': HttpStatus.CONFLICT,
  'service-unavailable': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<KnowledgeRefusal, string>> = {
  'article-source-fixed':
    'Help center articles are synced on publish and follow their own visibility',
  'invalid-config': 'The settings do not fit this kind of source',
  'not-a-file': 'Only a file source has an upload to confirm',
  'upload-missing': 'The file is not in storage, or is larger than declared',
  'rendering-disabled': 'JavaScript rendering is turned off on this install',
  'oauth-not-configured': 'This install has no OAuth app for that service',
  'oauth-state-invalid': 'The sign-in answer did not match a request from this install',
  'not-connected': 'Connect the source first',
  'connection-refused': 'The service refused the stored connection; reconnect it',
  'service-unavailable': 'The service could not be reached',
};

export class KnowledgeFailure extends HttpException {
  readonly reason: KnowledgeRefusal;

  constructor(reason: KnowledgeRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'KnowledgeFailure';
    this.reason = reason;
  }
}
