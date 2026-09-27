import type { WidgetErrorCode } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A widget request refused by a rule (M4-02 to M4-04). The same shape as
 * `channels/channels-failure.ts`: the status is how bad it is, `reason` is
 * which rule said no, and the widget picks its words from `reason`. The
 * messages are for the log and for a native-app developer reading `curl`.
 */

const STATUS_BY_CODE: Readonly<Record<WidgetErrorCode, number>> = {
  origin_not_allowed: HttpStatus.FORBIDDEN,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  captcha_required: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  read_only: HttpStatus.CONFLICT,
  content_policy: HttpStatus.BAD_REQUEST,
  unavailable: HttpStatus.NOT_FOUND,
  invalid_payload: HttpStatus.BAD_REQUEST,
  internal: HttpStatus.INTERNAL_SERVER_ERROR,
};

export const WIDGET_FAILURE_MESSAGES: Readonly<Record<WidgetErrorCode, string>> = {
  origin_not_allowed: "This page's origin is not in the brand's allowed origins",
  unauthenticated: 'A visitor credential is required: Authorization: Visitor <secret>',
  rate_limited: 'Too many requests; wait a moment and try again',
  captcha_required: 'This brand asks for a CAPTCHA before the first message',
  not_found: 'No such conversation',
  read_only: 'This conversation cannot be written to from the widget',
  content_policy: "The brand's content policy does not allow this",
  unavailable: 'The widget is not available for this brand',
  invalid_payload: 'The message did not match the expected shape',
  internal: 'The request could not be completed',
};

export class WidgetFailure extends HttpException {
  readonly reason: WidgetErrorCode;

  constructor(reason: WidgetErrorCode, message: string = WIDGET_FAILURE_MESSAGES[reason]) {
    super(message, STATUS_BY_CODE[reason]);
    this.name = 'WidgetFailure';
    this.reason = reason;
  }
}
