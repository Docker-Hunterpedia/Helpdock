import type { Db } from '@helpdock/db';
import {
  type KnowledgeBrowse,
  type KnowledgeFilePresignResponse,
  type KnowledgeLog,
  type KnowledgeOAuthStart,
  type KnowledgeSourceCreateInput,
  type KnowledgeSourceList,
  type KnowledgeSourceView,
  knowledgeSourceCreateSchema,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Public, Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { DB } from '../runtime/tokens.js';
import {
  KnowledgeBrandParamDto,
  KnowledgeBrowseDto,
  KnowledgeBrowseQueryDto,
  KnowledgeFilePresignDto,
  KnowledgeFilePresignResponseDto,
  KnowledgeLogDto,
  KnowledgeLogQueryDto,
  KnowledgeOAuthCallbackQueryDto,
  KnowledgeOAuthProviderParamDto,
  KnowledgeOAuthStartDto,
  KnowledgeSourceListDto,
  KnowledgeSourceParamDto,
  KnowledgeSourceUpdateDto,
  KnowledgeSourceViewDto,
} from './dto.js';
import { type KnowledgeContext, KnowledgeSourcesService } from './sources.service.js';

/**
 * A brand's knowledge sources (M7-03), shaped for the `Admin/AI-Knowledge`
 * artboard that M7-10 builds: the sources table, "Sync now", the add-source
 * dialog, the drawer's sync log, removal, and connecting Notion or Google
 * Drive. `ai:manage` — the Admin's and the Team Leader's, who manage the
 * brand's assistant (REQUIREMENTS §4.7).
 */
@Controller('api/brands/:brandId/knowledge')
export class KnowledgeController {
  readonly #sources: KnowledgeSourcesService;

  constructor(@Inject(KnowledgeSourcesService) sources: KnowledgeSourcesService) {
    this.#sources = sources;
  }

  @Get('sources')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeSourceListDto)
  list(
    @Param(new ZodValidationPipe(KnowledgeBrandParamDto)) { brandId }: KnowledgeBrandParamDto,
  ): Promise<KnowledgeSourceList> {
    return this.#sources.list(getTx(), brandId);
  }

  @Post('sources')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeSourceViewDto)
  create(
    @Param(new ZodValidationPipe(KnowledgeBrandParamDto)) { brandId }: KnowledgeBrandParamDto,
    // A discriminated union, which a DTO class cannot extend.
    @Body(new ZodValidationPipe(knowledgeSourceCreateSchema)) body: KnowledgeSourceCreateInput,
  ): Promise<KnowledgeSourceView> {
    return this.#sources.create(this.#context(brandId), body);
  }

  @Get('sources/:sourceId')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeSourceViewDto)
  get(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) {
      brandId,
      sourceId,
    }: KnowledgeSourceParamDto,
  ): Promise<KnowledgeSourceView> {
    return this.#sources.get(getTx(), brandId, sourceId);
  }

  @Patch('sources/:sourceId')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeSourceViewDto)
  update(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) {
      brandId,
      sourceId,
    }: KnowledgeSourceParamDto,
    @Body(new ZodValidationPipe(KnowledgeSourceUpdateDto)) body: KnowledgeSourceUpdateDto,
  ): Promise<KnowledgeSourceView> {
    return this.#sources.update(this.#context(brandId), sourceId, body);
  }

  @Delete('sources/:sourceId')
  @Requires('ai:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) {
      brandId,
      sourceId,
    }: KnowledgeSourceParamDto,
  ): Promise<void> {
    await this.#sources.remove(this.#context(brandId), sourceId);
  }

  @Post('sources/:sourceId/sync')
  @Requires('ai:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(KnowledgeSourceViewDto)
  sync(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) {
      brandId,
      sourceId,
    }: KnowledgeSourceParamDto,
  ): Promise<KnowledgeSourceView> {
    return this.#sources.syncNow(this.#context(brandId), sourceId);
  }

  @Get('sources/:sourceId/log')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeLogDto)
  log(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) { sourceId }: KnowledgeSourceParamDto,
    @Query(new ZodValidationPipe(KnowledgeLogQueryDto)) query: KnowledgeLogQueryDto,
  ): Promise<KnowledgeLog> {
    return this.#sources.log(getTx(), sourceId, query);
  }

  @Get('sources/:sourceId/browse')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeBrowseDto)
  browse(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) { sourceId }: KnowledgeSourceParamDto,
    @Query(new ZodValidationPipe(KnowledgeBrowseQueryDto)) query: KnowledgeBrowseQueryDto,
  ): Promise<KnowledgeBrowse> {
    return this.#sources.browse(getTx(), sourceId, query);
  }

  @Post('files')
  @Requires('ai:manage')
  @ZodSerializerDto(KnowledgeFilePresignResponseDto)
  presign(
    @Param(new ZodValidationPipe(KnowledgeBrandParamDto)) { brandId }: KnowledgeBrandParamDto,
    @Body(new ZodValidationPipe(KnowledgeFilePresignDto)) body: KnowledgeFilePresignDto,
  ): Promise<KnowledgeFilePresignResponse> {
    return this.#sources.presignFile(this.#context(brandId), body);
  }

  @Post('sources/:sourceId/confirm')
  @Requires('ai:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(KnowledgeSourceViewDto)
  confirm(
    @Param(new ZodValidationPipe(KnowledgeSourceParamDto)) {
      brandId,
      sourceId,
    }: KnowledgeSourceParamDto,
  ): Promise<KnowledgeSourceView> {
    return this.#sources.confirmFile(this.#context(brandId), sourceId);
  }

  @Post('sources/:sourceId/oauth/:provider')
  @Requires('ai:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(KnowledgeOAuthStartDto)
  oauthStart(
    @Param(new ZodValidationPipe(KnowledgeOAuthProviderParamDto)) {
      brandId,
      sourceId,
      provider,
    }: KnowledgeOAuthProviderParamDto,
  ): Promise<KnowledgeOAuthStart> {
    return this.#sources.oauthStart(this.#context(brandId), sourceId, provider);
  }

  #context(brandId: string): KnowledgeContext {
    return {
      tx: getTx(),
      brandId,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
    };
  }
}

/**
 * Where Notion and Google send the browser back after consent. `@Public()`:
 * the browser arrives without the admin's session, and the signed `state` is
 * what ties the answer to the brand, source and person that asked
 * (`oauth-state.ts`).
 */
@Controller('api/knowledge/oauth')
export class KnowledgeOAuthController {
  readonly #sources: KnowledgeSourcesService;
  readonly #db: Db;

  constructor(
    @Inject(KnowledgeSourcesService) sources: KnowledgeSourcesService,
    @Inject(DB) db: Db,
  ) {
    this.#sources = sources;
    this.#db = db;
  }

  @Get('callback')
  @Public()
  @Header('Cache-Control', 'no-store')
  async callback(
    @Query(new ZodValidationPipe(KnowledgeOAuthCallbackQueryDto))
    query: KnowledgeOAuthCallbackQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const target = await this.#sources.oauthCallback(this.#db, query);
    await reply.redirect(target, HttpStatus.FOUND);
  }
}
