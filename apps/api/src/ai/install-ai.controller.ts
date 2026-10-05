import type {
  AiModelList,
  AiProvidersOverview,
  AiProviderView,
  EmbeddingSettingsView,
  TranscriptionSettingsView,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  AiDefaultModelUpdateDto,
  AiModelListDto,
  AiProviderParamDto,
  AiProvidersOverviewDto,
  AiProviderUpsertDto,
  AiProviderViewDto,
  EmbeddingSettingsUpdateDto,
  EmbeddingSettingsViewDto,
  TranscriptionSettingsUpdateDto,
  TranscriptionSettingsViewDto,
} from './dto.js';
import { EmbeddingSettingsService } from './embedding-settings.service.js';
import { InstallAiService } from './install-ai.service.js';
import { TranscriptionSettingsService } from './transcription-settings.service.js';

/**
 * Settings › AI › Providers, Embeddings and voice transcription (M7-01, M7-02; screen in M7-10 from
 * the `Admin/AI-Providers` artboard). Install-wide, so every route is
 * `install:admin`, runs in install scope and is audited on entry.
 */
@Controller('api/install/ai')
export class InstallAiController {
  readonly #ai: InstallAiService;
  readonly #embedding: EmbeddingSettingsService;
  readonly #transcription: TranscriptionSettingsService;

  constructor(
    @Inject(InstallAiService) ai: InstallAiService,
    @Inject(EmbeddingSettingsService) embedding: EmbeddingSettingsService,
    @Inject(TranscriptionSettingsService) transcription: TranscriptionSettingsService,
  ) {
    this.#ai = ai;
    this.#embedding = embedding;
    this.#transcription = transcription;
  }

  @Get('providers')
  @Requires('install:admin')
  @ZodSerializerDto(AiProvidersOverviewDto)
  overview(): Promise<AiProvidersOverview> {
    return this.#ai.overview();
  }

  @Put('providers/:providerId')
  @Requires('install:admin')
  @ZodSerializerDto(AiProviderViewDto)
  upsert(
    @Param(new ZodValidationPipe(AiProviderParamDto)) { providerId }: AiProviderParamDto,
    @Body(new ZodValidationPipe(AiProviderUpsertDto)) body: AiProviderUpsertDto,
  ): Promise<AiProviderView> {
    return this.#ai.upsert(this.#context(), providerId, body);
  }

  @Delete('providers/:providerId')
  @Requires('install:admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(AiProviderParamDto)) { providerId }: AiProviderParamDto,
  ): Promise<void> {
    await this.#ai.remove(this.#context(), providerId);
  }

  @Get('providers/:providerId/models')
  @Requires('install:admin')
  @ZodSerializerDto(AiModelListDto)
  models(
    @Param(new ZodValidationPipe(AiProviderParamDto)) { providerId }: AiProviderParamDto,
  ): Promise<AiModelList> {
    return this.#ai.models(providerId);
  }

  @Put('default-model')
  @Requires('install:admin')
  @ZodSerializerDto(AiProvidersOverviewDto)
  setDefaults(
    @Body(new ZodValidationPipe(AiDefaultModelUpdateDto)) body: AiDefaultModelUpdateDto,
  ): Promise<AiProvidersOverview> {
    return this.#ai.setDefaults(this.#context(), body);
  }

  @Get('embedding')
  @Requires('install:admin')
  @ZodSerializerDto(EmbeddingSettingsViewDto)
  embedding(): Promise<EmbeddingSettingsView> {
    return this.#embedding.view(getTx());
  }

  @Put('embedding')
  @Requires('install:admin')
  @ZodSerializerDto(EmbeddingSettingsViewDto)
  updateEmbedding(
    @Body(new ZodValidationPipe(EmbeddingSettingsUpdateDto)) body: EmbeddingSettingsUpdateDto,
  ): Promise<EmbeddingSettingsView> {
    return this.#embedding.update(getTx(), this.#context().actorId, body);
  }

  @Get('transcription')
  @Requires('install:admin')
  @ZodSerializerDto(TranscriptionSettingsViewDto)
  transcription(): Promise<TranscriptionSettingsView> {
    return this.#transcription.view();
  }

  @Put('transcription')
  @Requires('install:admin')
  @ZodSerializerDto(TranscriptionSettingsViewDto)
  updateTranscription(
    @Body(new ZodValidationPipe(TranscriptionSettingsUpdateDto))
    body: TranscriptionSettingsUpdateDto,
  ): Promise<TranscriptionSettingsView> {
    return this.#transcription.update(getTx(), this.#context().actorId, body);
  }

  #context() {
    return { tx: getTx(), actorId: requireStaffPrincipalId(requireRequestContext().principal) };
  }
}
