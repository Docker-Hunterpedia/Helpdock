import type {
  AssignableAgentList,
  MessageCreateRequest,
  Ticket,
  TicketActivityList,
  TicketCreateRequest,
  TicketDetail,
  TicketList,
  TicketMessage,
  TicketMessagePage,
  TicketStatusList,
  TicketUpdateRequest,
} from '@helpdock/schemas';
import {
  assignableAgentListSchema,
  ticketActivityListSchema,
  ticketDetailSchema,
  ticketListSchema,
  ticketMessagePageSchema,
  ticketMessageSchema,
  ticketSchema,
  ticketStatusListSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { TicketQuery, TicketsApi } from './api.js';

/**
 * The real ticket service (M1-02, M1-03). It shares its {@link HttpTransport}
 * with `HttpAuthApi`, so there is one access token and one refresh in the app.
 *
 * Every response is parsed through the schema `apps/api` declared it with, so a
 * shape the two disagree about fails here rather than three components deep.
 */
export class HttpTicketsApi implements TicketsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async statuses(brandId: string): Promise<TicketStatusList> {
    return ticketStatusListSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}/ticket-statuses`),
    );
  }

  async list(brandId: string, query: TicketQuery = {}): Promise<TicketList> {
    return ticketListSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#brand(brandId)}/tickets${listQueryString(query)}`,
      ),
    );
  }

  async ticket(brandId: string, ticketId: string): Promise<TicketDetail> {
    return ticketDetailSchema.parse(
      await this.#transport.request('GET', this.#ticket(brandId, ticketId)),
    );
  }

  async messages(brandId: string, ticketId: string, after = 0): Promise<TicketMessagePage> {
    return ticketMessagePageSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#ticket(brandId, ticketId)}/messages?after=${after}`,
      ),
    );
  }

  async activity(brandId: string, ticketId: string): Promise<TicketActivityList> {
    return ticketActivityListSchema.parse(
      await this.#transport.request('GET', `${this.#ticket(brandId, ticketId)}/activity`),
    );
  }

  async create(brandId: string, request: TicketCreateRequest): Promise<TicketDetail> {
    return ticketDetailSchema.parse(
      await this.#transport.request('POST', `${this.#brand(brandId)}/tickets`, request),
    );
  }

  async update(brandId: string, ticketId: string, request: TicketUpdateRequest): Promise<Ticket> {
    return ticketSchema.parse(
      await this.#transport.request('PATCH', this.#ticket(brandId, ticketId), request),
    );
  }

  async reply(
    brandId: string,
    ticketId: string,
    request: MessageCreateRequest,
  ): Promise<TicketMessage> {
    return ticketMessageSchema.parse(
      await this.#transport.request('POST', `${this.#ticket(brandId, ticketId)}/messages`, request),
    );
  }

  async assignable(brandId: string, departmentId: string): Promise<AssignableAgentList> {
    return assignableAgentListSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#brand(brandId)}/assignment/${encodeURIComponent(departmentId)}/assignable`,
      ),
    );
  }

  #brand(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}`;
  }

  #ticket(brandId: string, ticketId: string): string {
    return `${this.#brand(brandId)}/tickets/${encodeURIComponent(ticketId)}`;
  }
}

/**
 * The filters as a query string. A repeated key per array member, because that
 * is the shape `ticketListQuerySchema` coerces; an empty array is left off
 * entirely, so "no status chosen" is no parameter rather than a filter that
 * matches nothing.
 */
export const listQueryString = (query: TicketQuery): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const member of value) {
        params.append(key, String(member));
      }
      continue;
    }

    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const rendered = params.toString();

  return rendered === '' ? '' : `?${rendered}`;
};
