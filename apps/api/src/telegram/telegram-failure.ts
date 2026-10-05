import type { TelegramRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A bot action refused by a rule or by Telegram rather than by a permission
 * (M6-05). The same shape as `channels-failure.ts`: the screen picks its words
 * from `reason`; the messages below are for the log and for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<TelegramRefusal, number>> = {
  'token-invalid': HttpStatus.BAD_REQUEST,
  // Not a 5xx: the install is fine, the other side did not answer.
  'telegram-unreachable': HttpStatus.CONFLICT,
  'bot-taken': HttpStatus.CONFLICT,
  'token-other-bot': HttpStatus.BAD_REQUEST,
  'department-not-found': HttpStatus.NOT_FOUND,
};

const MESSAGE_BY_REASON: Readonly<Record<TelegramRefusal, string>> = {
  'token-invalid': 'Telegram does not recognise that token',
  'telegram-unreachable': 'Telegram could not be reached to check the token',
  'bot-taken': 'That bot is already connected to a brand on this install',
  'token-other-bot': 'The new token belongs to a different bot',
  'department-not-found': 'No such department in this brand',
};

export class TelegramFailure extends HttpException {
  readonly reason: TelegramRefusal;

  constructor(reason: TelegramRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'TelegramFailure';
    this.reason = reason;
  }
}
