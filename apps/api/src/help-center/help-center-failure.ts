import type { HcRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A help center change refused by a rule rather than by a permission, in the
 * shape of `channels/channels-failure.ts`: the status says "conflict", the
 * reason says which rule, and the Articles tab turns it into a sentence. The
 * messages are for the log and for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<HcRefusal, number>> = {
  'slug-taken': HttpStatus.CONFLICT,
  'not-empty': HttpStatus.CONFLICT,
  'was-published': HttpStatus.CONFLICT,
  'schedule-in-past': HttpStatus.BAD_REQUEST,
  'limit-reached': HttpStatus.CONFLICT,
  'low-contrast': HttpStatus.UNPROCESSABLE_ENTITY,
  'media-not-ready': HttpStatus.UNPROCESSABLE_ENTITY,
  'unknown-article': HttpStatus.UNPROCESSABLE_ENTITY,
};

const MESSAGE_BY_REASON: Readonly<Record<HcRefusal, string>> = {
  'slug-taken': 'Another one of this brand already has that address',
  'not-empty': 'Move or delete what is inside it first',
  'was-published': 'This article has been published, so it is archived rather than deleted',
  'schedule-in-past': 'A scheduled publish has to be in the future',
  'limit-reached': 'This help center already has as many of these as it may keep',
  'low-contrast':
    'That accent is below 3:1 against the page, so text and buttons on it would not be readable',
  'media-not-ready': 'That image is not a finished upload for this purpose',
  'unknown-article': 'One of the featured articles is not in this help center',
};

export class HelpCenterFailure extends HttpException {
  readonly reason: HcRefusal;

  constructor(reason: HcRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'HelpCenterFailure';
    this.reason = reason;
  }
}
