import { createHash } from 'node:crypto';
import type {
  AttachmentPresignResponse,
  WidgetAttachment,
  WidgetAvailability,
  WidgetConfig,
  WidgetConversation,
  WidgetConversationList,
  WidgetMessagePage,
  WidgetQueue,
  WidgetSendResponse,
  WidgetSession,
  WidgetStartResponse,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import {
  WidgetAttachmentDto,
  WidgetAttachmentParamDto,
  WidgetAvailabilityDto,
  WidgetBrandParamDto,
  WidgetConfigDto,
  WidgetConfigQueryDto,
  WidgetConversationDto,
  WidgetConversationListDto,
  WidgetConversationParamDto,
  WidgetDownloadDto,
  WidgetDownloadQueryDto,
  WidgetMessagePageDto,
  WidgetMessagesQueryDto,
  WidgetQueueDto,
  WidgetReadRequestDto,
  WidgetSendRequestDto,
  WidgetSendResponseDto,
  WidgetSessionDto,
  WidgetSessionRequestDto,
  WidgetStartRequestDto,
  WidgetStartResponseDto,
  WidgetTranscriptRequestDto,
  WidgetTypingRequestDto,
  WidgetUploadRequestDto,
  WidgetUploadResponseDto,
} from './dto.js';
import { WidgetActivityService } from './widget-activity.service.js';
import { WidgetConfigService } from './widget-config.service.js';
import { WidgetConversationsService } from './widget-conversations.service.js';
import type { WidgetRequestFacts } from './widget-gate.js';
import { WidgetSessionService } from './widget-session.service.js';
import { WidgetUploadsService } from './widget-uploads.service.js';

/** The request facts every widget route is judged on: origin, credential, address. */
export const factsOf = (request: FastifyRequest): WidgetRequestFacts => ({
  origin: request.headers.origin,
  authorization: request.headers.authorization,
  ip: request.ip ?? null,
});

/**
 * The widget's REST half (M4-02 to M4-04, M4-08; `docs/guides/widget-protocol.md`).
 *
 * Every route is `@Public()` to the staff guards because a visitor has no
 * staff session: the visitor credential, the origin allow-list and the
 * throttles are checked by `WidgetGate` in front of every handler, and the
 * work runs in a transaction scoped to the one brand in the path. REST is the
 * truth of DOMAIN-RULES §7; the socket and the SSE stream only tell a client
 * when to read it again.
 */
@Controller('api/widget/:brandId')
export class WidgetController {
  readonly #config: WidgetConfigService;
  readonly #session: WidgetSessionService;
  readonly #conversations: WidgetConversationsService;
  readonly #activity: WidgetActivityService;
  readonly #uploads: WidgetUploadsService;

  constructor(
    @Inject(WidgetConfigService) config: WidgetConfigService,
    @Inject(WidgetSessionService) session: WidgetSessionService,
    @Inject(WidgetConversationsService) conversations: WidgetConversationsService,
    @Inject(WidgetActivityService) activity: WidgetActivityService,
    @Inject(WidgetUploadsService) uploads: WidgetUploadsService,
  ) {
    this.#config = config;
    this.#session = session;
    this.#conversations = conversations;
    this.#activity = activity;
    this.#uploads = uploads;
  }

  /**
   * The first paint's everything, in `?locale=`, with an `ETag` so a reload
   * costs a 304 (ARCHITECTURE §12).
   */
  @Get('config')
  @Public()
  async config(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Query(new ZodValidationPipe(WidgetConfigQueryDto)) { locale }: WidgetConfigQueryDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WidgetConfig | undefined> {
    const config = WidgetConfigDto.schema.parse(
      await this.#config.config(brandId, factsOf(request), locale),
    ) as WidgetConfig;
    const etag = `"${createHash('sha256').update(JSON.stringify(config)).digest('base64url').slice(0, 27)}"`;
    void reply.header('etag', etag).header('cache-control', 'no-cache');
    if (request.headers['if-none-match'] === etag) {
      void reply.code(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return config;
  }

  @Get('availability')
  @Public()
  @ZodSerializerDto(WidgetAvailabilityDto)
  availability(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetAvailability> {
    return this.#config.availability(brandId, factsOf(request));
  }

  @Post('session')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(WidgetSessionDto)
  session(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Body(new ZodValidationPipe(WidgetSessionRequestDto)) body: WidgetSessionRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetSession> {
    return this.#session.session(brandId, factsOf(request), body);
  }

  @Get('conversations')
  @Public()
  @ZodSerializerDto(WidgetConversationListDto)
  list(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetConversationList> {
    return this.#conversations.list(brandId, factsOf(request));
  }

  @Post('conversations')
  @Public()
  @ZodSerializerDto(WidgetStartResponseDto)
  start(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Body(new ZodValidationPipe(WidgetStartRequestDto)) body: WidgetStartRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetStartResponse> {
    return this.#conversations.start(brandId, factsOf(request), body);
  }

  @Get('conversations/:conversationId')
  @Public()
  @ZodSerializerDto(WidgetConversationDto)
  conversation(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetConversation> {
    return this.#conversations.get(brandId, factsOf(request), conversationId);
  }

  /** §7's catch-up: `?after=<last_seq>`. */
  @Get('conversations/:conversationId/messages')
  @Public()
  @ZodSerializerDto(WidgetMessagePageDto)
  messages(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Query(new ZodValidationPipe(WidgetMessagesQueryDto)) query: WidgetMessagesQueryDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetMessagePage> {
    return this.#conversations.messages(brandId, factsOf(request), conversationId, query);
  }

  /** §7's send. The response's `seq` is what makes the message "sent". */
  @Post('conversations/:conversationId/messages')
  @Public()
  @ZodSerializerDto(WidgetSendResponseDto)
  send(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Body(new ZodValidationPipe(WidgetSendRequestDto)) body: WidgetSendRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetSendResponse> {
    return this.#conversations.send(brandId, factsOf(request), conversationId, body);
  }

  @Get('conversations/:conversationId/queue')
  @Public()
  @ZodSerializerDto(WidgetQueueDto)
  queue(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetQueue> {
    return this.#conversations.queue(brandId, factsOf(request), conversationId);
  }

  /** Typing over REST, for a client on the SSE fallback. */
  @Post('conversations/:conversationId/typing')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async typing(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Body(new ZodValidationPipe(WidgetTypingRequestDto)) body: WidgetTypingRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.#activity.typing(brandId, factsOf(request), conversationId, body.typing);
  }

  @Post('conversations/:conversationId/read')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Body(new ZodValidationPipe(WidgetReadRequestDto)) body: WidgetReadRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.#activity.read(brandId, factsOf(request), conversationId, body.seq);
  }

  @Post('conversations/:conversationId/transcript')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  async transcript(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Body(new ZodValidationPipe(WidgetTranscriptRequestDto)) body: WidgetTranscriptRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.#activity.transcript(brandId, factsOf(request), conversationId, body.email);
  }

  @Post('conversations/:conversationId/attachments')
  @Public()
  @ZodSerializerDto(WidgetUploadResponseDto)
  presign(
    @Param(new ZodValidationPipe(WidgetConversationParamDto))
    { brandId, conversationId }: WidgetConversationParamDto,
    @Body(new ZodValidationPipe(WidgetUploadRequestDto)) body: WidgetUploadRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<AttachmentPresignResponse> {
    return this.#uploads.presign(brandId, factsOf(request), conversationId, body);
  }

  @Post('conversations/:conversationId/attachments/:attachmentId/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(WidgetAttachmentDto)
  confirm(
    @Param(new ZodValidationPipe(WidgetAttachmentParamDto))
    { brandId, conversationId, attachmentId }: WidgetAttachmentParamDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetAttachment> {
    return this.#uploads.confirm(brandId, factsOf(request), conversationId, attachmentId);
  }

  @Get('conversations/:conversationId/attachments/:attachmentId')
  @Public()
  @ZodSerializerDto(WidgetDownloadDto)
  download(
    @Param(new ZodValidationPipe(WidgetAttachmentParamDto))
    { brandId, conversationId, attachmentId }: WidgetAttachmentParamDto,
    @Query(new ZodValidationPipe(WidgetDownloadQueryDto)) query: WidgetDownloadQueryDto,
    @Req() request: FastifyRequest,
  ): Promise<{ attachment: WidgetAttachment; url: string; expiresAt: string }> {
    return this.#uploads.download(brandId, factsOf(request), conversationId, attachmentId, query);
  }
}
