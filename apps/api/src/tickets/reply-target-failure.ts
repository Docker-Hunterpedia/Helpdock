import type { ReplyTargetRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * M14-31. Why a public reply's `replyToMessageId` was refused. A 400 names the
 * field (`body.replyToMessageId`) so the composer can say which input is wrong;
 * the 409 is the target being gone (or not one the caller can read, which the
 * policies make look the same), and the reply is not sent.
 */
export class ReplyTargetFailure extends HttpException {
  readonly reason: ReplyTargetRefusal;

  constructor(reason: ReplyTargetRefusal) {
    super(`reply-to.${reason}`, reason === 'gone' ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST);
    this.reason = reason;
    this.name = 'ReplyTargetFailure';
  }
}
