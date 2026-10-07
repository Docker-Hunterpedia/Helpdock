import type { WebhooksRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An endpoint refused by the outbound rules rather than by a permission
 * (M8-03). The same shape as `domains/domains-failure.ts`: the Developers page
 * picks its sentence from `reason`; the messages below are for the log and for
 * `curl`.
 */

const MESSAGE_BY_REASON: Readonly<Record<WebhooksRefusal, string>> = {
  'webhook-https-required': 'Use https://; webhooks are never sent over plain HTTP',
  'webhook-destination-blocked':
    'That address is private, loopback or link-local; Helpdock only delivers to public addresses',
};

export class WebhooksFailure extends HttpException {
  readonly reason: WebhooksRefusal;
  readonly address: string | undefined;

  constructor(reason: WebhooksRefusal, address?: string) {
    super(MESSAGE_BY_REASON[reason], HttpStatus.BAD_REQUEST);
    this.name = 'WebhooksFailure';
    this.reason = reason;
    this.address = address;
  }
}
