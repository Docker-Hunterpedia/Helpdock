import {
  type WidgetArticle,
  type WidgetArticleSearch,
  widgetArticleParamSchema,
  widgetArticleQuerySchema,
  widgetArticleSchema,
  widgetArticleSearchQuerySchema,
  widgetArticleSearchSchema,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { WidgetBrandParamDto } from './dto.js';
import { factsOf } from './widget.controller.js';
import { WidgetArticlesService } from './widget-articles.service.js';

class WidgetArticleSearchQueryDto extends createZodDto(widgetArticleSearchQuerySchema) {}
class WidgetArticleSearchDto extends createZodDto(widgetArticleSearchSchema) {}
class WidgetArticleParamDto extends createZodDto(widgetArticleParamSchema) {}
class WidgetArticleQueryDto extends createZodDto(widgetArticleQuerySchema) {}
class WidgetArticleDto extends createZodDto(widgetArticleSchema) {}

/**
 * The widget's help center routes (M5-10; `docs/guides/widget-protocol.md`,
 * "Help center"). `@Public()` to the staff guards for the reason
 * `WidgetController` gives: `WidgetArticlesService` runs `WidgetGate` — origin,
 * visitor credential, throttle — before it reads, and reads the public
 * audience only.
 */
@Controller('api/widget/:brandId/articles')
export class WidgetArticlesController {
  readonly #articles: WidgetArticlesService;

  constructor(@Inject(WidgetArticlesService) articles: WidgetArticlesService) {
    this.#articles = articles;
  }

  @Get()
  @Public()
  @ZodSerializerDto(WidgetArticleSearchDto)
  search(
    @Param(new ZodValidationPipe(WidgetBrandParamDto)) { brandId }: WidgetBrandParamDto,
    @Query(new ZodValidationPipe(WidgetArticleSearchQueryDto)) query: WidgetArticleSearchQueryDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetArticleSearch> {
    return this.#articles.search(brandId, factsOf(request), query);
  }

  @Get(':articleId')
  @Public()
  @ZodSerializerDto(WidgetArticleDto)
  article(
    @Param(new ZodValidationPipe(WidgetArticleParamDto)) params: WidgetArticleParamDto,
    @Query(new ZodValidationPipe(WidgetArticleQueryDto)) query: WidgetArticleQueryDto,
    @Req() request: FastifyRequest,
  ): Promise<WidgetArticle> {
    return this.#articles.article(params.brandId, factsOf(request), params.articleId, query);
  }
}
