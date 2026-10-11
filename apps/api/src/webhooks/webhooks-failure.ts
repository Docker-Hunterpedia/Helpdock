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
  'webhook-event-scope': 'This API key lacks the read scope for the events of that endpoint',
};

/** A refusal about who is asking is a 403; one about where the endpoint points is a 400. */
const STATUS_BY_REASON: Readonly<Partial<Record<WebhooksRefusal, HttpStatus>>> = {
  'webhook-event-scope': HttpStatus.FORBIDDEN,
};

export class WebhooksFailure extends HttpException {
  readonly reason: WebhooksRefusal;
  readonly address: string | undefined;

  constructor(reason: WebhooksRefusal, address?: string) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason] ?? HttpStatus.BAD_REQUEST);
    this.name = 'WebhooksFailure';
    this.reason = reason;
    this.address = address;
  }
}
