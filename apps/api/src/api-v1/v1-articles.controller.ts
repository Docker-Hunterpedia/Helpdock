import type { HcPublishedArticle, V1ArticleSearch } from '@helpdock/schemas';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { defaultLocaleOf, readArticle } from '../help-center/content-reader.js';
import { HELP_CENTER_SEARCH, type HelpCenterSearch } from '../help-center/ports.js';
import { apiKeyPrincipal } from './api-key-context.js';
import {
  V1ArticleDto,
  V1ArticleParamDto,
  V1ArticleQueryDto,
  V1ArticleSearchDto,
  V1ArticleSearchQueryDto,
} from './dto.js';

/**
 * M8-02: the help center over the public API. An integration reads what a
 * visitor reads — published, public articles — with the visibility filter in
 * the SQL before anything is ranked (DOMAIN-RULES §5). A key is not a staff
 * member, and nothing it fetches may be internal. Its searches are not written
 * to the search log, whose Insights are about what customers look for.
 */
@Controller('api/v1/articles')
export class V1ArticlesController {
  readonly #search: HelpCenterSearch;

  constructor(@Inject(HELP_CENTER_SEARCH) search: HelpCenterSearch) {
    this.#search = search;
  }

  @Get()
  @Requires('articles:read')
  @ZodSerializerDto(V1ArticleSearchDto)
  async search(
    @Query(new ZodValidationPipe(V1ArticleSearchQueryDto)) query: V1ArticleSearchQueryDto,
  ): Promise<V1ArticleSearch> {
    const result = await this.#search.search({
      brandId: apiKeyPrincipal().brandId,
      audience: 'public',
      locale: query.locale,
      q: query.q,
      limit: query.limit,
      offset: query.offset,
      source: 'help_center',
      log: false,
    });
    return { hits: [...result.hits], total: result.total };
  }

  @Get(':slug')
  @Requires('articles:read')
  @ZodSerializerDto(V1ArticleDto)
  async find(
    @Param(new ZodValidationPipe(V1ArticleParamDto)) { slug }: V1ArticleParamDto,
    @Query(new ZodValidationPipe(V1ArticleQueryDto)) query: V1ArticleQueryDto,
  ): Promise<HcPublishedArticle> {
    const tx = getTx();
    const lookup = await readArticle(
      tx,
      {
        audience: 'public',
        locale: query.locale,
        defaultLocale: await defaultLocaleOf(tx, apiKeyPrincipal().brandId),
      },
      slug,
    );
    if (lookup.state !== 'found') {
      throw new NotFoundException('No such article');
    }
    return lookup.article;
  }
}
