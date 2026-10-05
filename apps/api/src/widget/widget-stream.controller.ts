import type { ServerResponse } from 'node:http';
import {
  WIDGET_EVENTS,
  WIDGET_SSE_MAX_AGE_MS,
  type WidgetEnvelope,
  type WidgetServerEvent,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { WidgetBrandParamDto, WidgetStreamQueryDto } from './dto.js';
import { factsOf } from './widget.controller.js';
import { WidgetConfigService } from './widget-config.service.js';
import { WidgetConversationsService } from './widget-conversations.service.js';
import { widgetCorsHeaders } from './widget-cors.js';
import { WidgetGate } from './widget-gate.js';
import { type StreamListener, WidgetHub } from './widget-hub.js';
import { brandVisitorsRoom, conversationRoom, widgetEnvelope } from './widget-relay.js';

/** The SSE stream's lifetime and heartbeat; a test shortens them. */
export interface WidgetStreamTimings {
  readonly maxAgeMs: number;
  readonly heartbeatMs: number;
}

export const WIDGET_STREAM_TIMINGS = Symbol('helpdock.widget-stream-timings');

export const DEFAULT_STREAM_TIMINGS: WidgetStreamTimings = {
  maxAgeMs: WIDGET_SSE_MAX_AGE_MS,
  heartbeatMs: 25_000,
};

const frame = (event: WidgetServerEvent, envelope: WidgetEnvelope<unknown>): string =>
  `event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;

/**
 * The SSE fallback of DOMAIN-RULES §7: `GET /api/widget/:brandId/stream
 * ?conversationId=…&after=<last_seq>`, for a network that will not carry a
 * WebSocket.
 *
 * - **Identical payloads.** Each event is the envelope a `/widget` socket
 *   receives, from the same hub, named by the same event name.
 * - **Sends go over REST**; this stream only listens.
 * - **No gap at the start.** The room is subscribed first and the catch-up
 *   after `after` is read second, so a message committed in between is in one
 *   or the other — and one already sent from the catch-up is not repeated.
 * - **Closed after five minutes**; the client reconnects with its cursor.
 *
 * `EventSource` cannot set headers, so the widget reads the stream with
 * `fetch` and the `Authorization: Visitor` header like every other route.
 */
@Controller('api/widget/:brandId')
export class WidgetStreamController {
  readonly #gate: WidgetGate;
  readonly #conversations: WidgetConversationsService;
  readonly #config: WidgetConfigService;
  readonly #hub: WidgetHub;
  readonly #timings: WidgetStreamTimings;

  constructor(
    @Inject(WidgetGate) gate: WidgetGate,
    @Inject(WidgetConversationsService) conversations: WidgetConversationsService,
    @Inject(WidgetConfigService) config: WidgetConfigService,
    @Inject(WidgetHub) hub: WidgetHub,
    @Inject(WIDGET_STREAM_TIMINGS) timings: WidgetStreamTimings,
  ) {
    this.#gate = gate;
    this.#conversations = conversations;
    this.#config = config;
    this.#hub = hub;
    this.#timings = timings;
  }

  @Get('stream')
  @Public()
  async stream(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Query(new ZodValidationPipe(WidgetStreamQueryDto)) query: WidgetStreamQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const facts = factsOf(request);
    const pending: string[] = [];
    let sentSeq = query.after;
    let write: ((chunk: string) => void) | null = null;
    const deliver: StreamListener = (event, envelope) => {
      if (envelope.seq !== null && envelope.seq <= sentSeq) {
        return;
      }
      if (envelope.seq !== null) {
        sentSeq = envelope.seq;
      }
      const chunk = frame(event, envelope);
      if (write === null) {
        pending.push(chunk);
      } else {
        write(chunk);
      }
    };

    // Everything that can refuse happens before the response is hijacked, so a
    // refusal is the ordinary JSON error body.
    const opened = await this.#gate.visitor(brandId, facts, { write: false }, async (scope) => {
      const entry = await this.#conversations.require(scope, query.conversationId);
      const unsubscribe = [
        this.#hub.listen(conversationRoom(entry.ticket.id), deliver),
        this.#hub.listen(brandVisitorsRoom(brandId), deliver),
      ];
      const page = await this.#conversations.page(scope, entry.ticket.id, {
        after: query.after,
        limit: 200,
      });
      return { unsubscribe, page };
    });

    reply.hijack();
    const raw: ServerResponse = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...widgetCorsHeaders(request.headers.origin),
    });

    const initial = opened.page.messages.map((message) =>
      frame(WIDGET_EVENTS.message, widgetEnvelope(WIDGET_EVENTS.message, message, message.seq)),
    );
    sentSeq = Math.max(sentSeq, opened.page.messages.at(-1)?.seq ?? 0);
    raw.write(`retry: 2000\n\n${initial.join('')}`);
    raw.write(
      frame(
        WIDGET_EVENTS.presence,
        widgetEnvelope(WIDGET_EVENTS.presence, await this.#config.presence(brandId), null),
      ),
    );
    write = (chunk) => raw.write(chunk);
    for (const chunk of pending.splice(0)) {
      raw.write(chunk);
    }

    const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), this.#timings.heartbeatMs);
    const close = (): void => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      for (const unsubscribe of opened.unsubscribe) {
        unsubscribe();
      }
      if (!raw.writableEnded) {
        raw.end();
      }
    };
    const expiry = setTimeout(close, this.#timings.maxAgeMs);
    heartbeat.unref();
    expiry.unref();
    request.raw.on('close', close);
  }
}
