import type {
  HcArticle,
  HcCategory,
  HcMedia,
  HcMediaPresignResponse,
  HcSection,
  HcSettings,
  HcStructure,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { HelpCenterArticlesService } from './articles.service.js';
import {
  HcArticleCreateRequestDto,
  HcArticleDto,
  HcArticleParamDto,
  HcArticleUpdateRequestDto,
  HcBrandParamDto,
  HcCategoryCreateRequestDto,
  HcCategoryDto,
  HcCategoryParamDto,
  HcCategoryUpdateRequestDto,
  HcMediaDto,
  HcMediaParamDto,
  HcMediaPresignRequestDto,
  HcMediaPresignResponseDto,
  HcReorderRequestDto,
  HcSectionCreateRequestDto,
  HcSectionDto,
  HcSectionParamDto,
  HcSectionUpdateRequestDto,
  HcSettingsDto,
  HcSettingsUpdateRequestDto,
  HcStructureDto,
  HcVersionParamDto,
  HcVersionSaveRequestDto,
  HcVersionStatusRequestDto,
  HcVersionVisibilityRequestDto,
} from './dto.js';
import { HelpCenterMediaService } from './media.service.js';
import { HelpCenterSettingsService } from './settings.service.js';
import { type HelpCenterContext, HelpCenterStructureService } from './structure.service.js';

/**
 * M5-01, M5-02 and M5-09 over HTTP: the Articles tab, the editor, and "Who can
 * read it".
 *
 * **Reading is `help_center:read`, which every role holds; everything else is
 * `help_center:manage`**, an Admin's and a Team Leader's (DOMAIN-RULES §1.2).
 * Content belongs to the brand, not to a department, so nothing below narrows
 * by department.
 */
@Controller('api/brands/:brandId/help-center')
export class HelpCenterController {
  readonly #structure: HelpCenterStructureService;
  readonly #articles: HelpCenterArticlesService;
  readonly #settings: HelpCenterSettingsService;
  readonly #media: HelpCenterMediaService;

  constructor(
    @Inject(HelpCenterStructureService) structure: HelpCenterStructureService,
    @Inject(HelpCenterArticlesService) articles: HelpCenterArticlesService,
    @Inject(HelpCenterSettingsService) settings: HelpCenterSettingsService,
    @Inject(HelpCenterMediaService) media: HelpCenterMediaService,
  ) {
    this.#structure = structure;
    this.#articles = articles;
    this.#settings = settings;
    this.#media = media;
  }

  @Get('structure')
  @Requires('help_center:read')
  @ZodSerializerDto(HcStructureDto)
  structure(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
  ): Promise<HcStructure> {
    return this.#structure.structure(context());
  }

  // ------------------------------------------------------------------ categories

  @Post('categories')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcCategoryDto)
  createCategory(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcCategoryCreateRequestDto)) body: HcCategoryCreateRequestDto,
  ): Promise<HcCategory> {
    return this.#structure.createCategory(context(), body);
  }

  @Post('categories/reorder')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcStructureDto)
  reorderCategories(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcReorderRequestDto)) body: HcReorderRequestDto,
  ): Promise<HcStructure> {
    return this.#structure.reorder(context(), 'categories', body);
  }

  @Patch('categories/:categoryId')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcCategoryDto)
  updateCategory(
    @Param(new ZodValidationPipe(HcCategoryParamDto)) { categoryId }: HcCategoryParamDto,
    @Body(new ZodValidationPipe(HcCategoryUpdateRequestDto)) body: HcCategoryUpdateRequestDto,
  ): Promise<HcCategory> {
    return this.#structure.updateCategory(context(), categoryId, body);
  }

  @Delete('categories/:categoryId')
  @Requires('help_center:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCategory(
    @Param(new ZodValidationPipe(HcCategoryParamDto)) { categoryId }: HcCategoryParamDto,
  ): Promise<void> {
    await this.#structure.deleteCategory(context(), categoryId);
  }

  // ------------------------------------------------------------------ sections

  @Post('sections')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcSectionDto)
  createSection(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcSectionCreateRequestDto)) body: HcSectionCreateRequestDto,
  ): Promise<HcSection> {
    return this.#structure.createSection(context(), body);
  }

  @Post('sections/reorder')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcStructureDto)
  reorderSections(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcReorderRequestDto)) body: HcReorderRequestDto,
  ): Promise<HcStructure> {
    return this.#structure.reorder(context(), 'sections', body);
  }

  @Patch('sections/:sectionId')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcSectionDto)
  updateSection(
    @Param(new ZodValidationPipe(HcSectionParamDto)) { sectionId }: HcSectionParamDto,
    @Body(new ZodValidationPipe(HcSectionUpdateRequestDto)) body: HcSectionUpdateRequestDto,
  ): Promise<HcSection> {
    return this.#structure.updateSection(context(), sectionId, body);
  }

  @Delete('sections/:sectionId')
  @Requires('help_center:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSection(
    @Param(new ZodValidationPipe(HcSectionParamDto)) { sectionId }: HcSectionParamDto,
  ): Promise<void> {
    await this.#structure.deleteSection(context(), sectionId);
  }

  // ------------------------------------------------------------------ articles

  @Post('articles')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcArticleDto)
  createArticle(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcArticleCreateRequestDto)) body: HcArticleCreateRequestDto,
  ): Promise<HcArticle> {
    return this.#articles.create(context(), body);
  }

  @Post('articles/reorder')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcStructureDto)
  reorderArticles(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcReorderRequestDto)) body: HcReorderRequestDto,
  ): Promise<HcStructure> {
    return this.#structure.reorder(context(), 'articles', body);
  }

  @Get('articles/:articleId')
  @Requires('help_center:read')
  @ZodSerializerDto(HcArticleDto)
  article(
    @Param(new ZodValidationPipe(HcArticleParamDto)) { articleId }: HcArticleParamDto,
  ): Promise<HcArticle> {
    return this.#articles.get(context(), articleId);
  }

  @Patch('articles/:articleId')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcArticleDto)
  updateArticle(
    @Param(new ZodValidationPipe(HcArticleParamDto)) { articleId }: HcArticleParamDto,
    @Body(new ZodValidationPipe(HcArticleUpdateRequestDto)) body: HcArticleUpdateRequestDto,
  ): Promise<HcArticle> {
    return this.#articles.update(context(), articleId, body);
  }

  @Delete('articles/:articleId')
  @Requires('help_center:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteArticle(
    @Param(new ZodValidationPipe(HcArticleParamDto)) { articleId }: HcArticleParamDto,
  ): Promise<void> {
    await this.#articles.remove(context(), articleId);
  }

  /** The editor's autosave of one language. Creates the version the first time. */
  @Put('articles/:articleId/versions/:locale')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcArticleDto)
  saveVersion(
    @Param(new ZodValidationPipe(HcVersionParamDto)) { articleId, locale }: HcVersionParamDto,
    @Body(new ZodValidationPipe(HcVersionSaveRequestDto)) body: HcVersionSaveRequestDto,
  ): Promise<HcArticle> {
    return this.#articles.save(context(), articleId, locale, body);
  }

  @Put('articles/:articleId/versions/:locale/status')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcArticleDto)
  setStatus(
    @Param(new ZodValidationPipe(HcVersionParamDto)) { articleId, locale }: HcVersionParamDto,
    @Body(new ZodValidationPipe(HcVersionStatusRequestDto)) body: HcVersionStatusRequestDto,
  ): Promise<HcArticle> {
    return this.#articles.setStatus(context(), articleId, locale, body);
  }

  @Put('articles/:articleId/versions/:locale/visibility')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcArticleDto)
  setVisibility(
    @Param(new ZodValidationPipe(HcVersionParamDto)) { articleId, locale }: HcVersionParamDto,
    @Body(new ZodValidationPipe(HcVersionVisibilityRequestDto))
    body: HcVersionVisibilityRequestDto,
  ): Promise<HcArticle> {
    return this.#articles.setVisibility(context(), articleId, locale, body.visibility);
  }

  // ------------------------------------------------------------------ settings

  @Get('settings')
  @Requires('help_center:read')
  @ZodSerializerDto(HcSettingsDto)
  settings(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
  ): Promise<HcSettings> {
    return this.#settings.get(context());
  }

  @Put('settings')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcSettingsDto)
  updateSettings(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcSettingsUpdateRequestDto)) body: HcSettingsUpdateRequestDto,
  ): Promise<HcSettings> {
    return this.#settings.update(context(), body);
  }

  // ------------------------------------------------------------------ images

  @Post('media/presign')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcMediaPresignResponseDto)
  presignMedia(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcMediaPresignRequestDto)) body: HcMediaPresignRequestDto,
  ): Promise<HcMediaPresignResponse> {
    const { tx, brandId, actorId } = context();
    return this.#media.presign(tx, { brandId, actorId }, body);
  }

  @Post('media/:mediaId/confirm')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcMediaDto)
  confirmMedia(
    @Param(new ZodValidationPipe(HcMediaParamDto)) { brandId, mediaId }: HcMediaParamDto,
  ): Promise<HcMedia> {
    return this.#media.confirm(getTx(), brandId, mediaId);
  }

  /** What the editor polls on after a confirm, until the image is `ready` or `rejected`. */
  @Get('media/:mediaId')
  @Requires('help_center:read')
  @ZodSerializerDto(HcMediaDto)
  media(
    @Param(new ZodValidationPipe(HcMediaParamDto)) { mediaId }: HcMediaParamDto,
  ): Promise<HcMedia> {
    return this.#media.get(getTx(), mediaId);
  }
}

/**
 * The request's transaction, brand and staff actor. Help center content is
 * staff work: an api key may one day hold these permissions (M8-01), but the
 * audit trail and the Activity panel name a person, so anything else is
 * refused here until that milestone decides what it names instead.
 */
const context = (): HelpCenterContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;
  if (principal?.type !== 'staff' || brandId === null) {
    throw new ForbiddenException('The help center is edited by staff');
  }
  return { tx: getTx(), brandId, actorId: principal.id };
};
