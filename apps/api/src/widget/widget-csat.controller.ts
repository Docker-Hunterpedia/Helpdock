import type { WidgetCsatResponse } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { WidgetConversationParamDto, WidgetCsatRequestDto, WidgetCsatResponseDto } from './dto.js';
import { factsOf } from './widget.controller.js';
import { WidgetCsatService } from './widget-csat.service.js';

/**
 * The satisfaction card of a closed widget conversation (M8-06,
 * `docs/guides/widget-protocol.md`). `@Public()` to the staff guards for the
 * reason every widget route is: `WidgetGate` checks the visitor's credential,
 * the origin and the throttles before any of these runs.
 */
@Controller('api/widget/:brandId/conversations/:conversationId/csat')
export class WidgetCsatController {
  readonly #csat: WidgetCsatService;

  constructor(@Inject(WidgetCsatService) csat: WidgetCsatService) {
    this.#csat = csat;
  }

  @Get()
  @Public()
  @ZodSerializerDto(WidgetCsatResponseDto)
  card(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetCsatResponse> {
    return this.#csat.card(brandId, factsOf(request), conversationId);
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(WidgetCsatResponseDto)
  rate(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Body(new ZodValidationPipe(WidgetCsatRequestDto)) body: WidgetCsatRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetCsatResponse> {
    return this.#csat.rate(brandId, factsOf(request), conversationId, body);
  }

  @Post('skip')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(WidgetCsatResponseDto)
  skip(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetCsatResponse> {
    return this.#csat.skip(brandId, factsOf(request), conversationId);
  }
}
