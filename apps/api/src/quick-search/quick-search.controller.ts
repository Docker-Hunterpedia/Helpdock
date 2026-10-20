import {
  brandIdParamSchema,
  type QuickSearch,
  quickSearchQuerySchema,
  quickSearchSchema,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { principalHasPermission } from '../auth/permissions.js';
import { principalIdOf } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { QuickSearchService } from './quick-search.service.js';

/** Declared here for the reason `keyboard.controller.ts` gives. */
class QuickSearchBrandParamDto extends createZodDto(brandIdParamSchema) {}
class QuickSearchQueryDto extends createZodDto(quickSearchQuerySchema) {}
class QuickSearchDto extends createZodDto(quickSearchSchema) {}

/**
 * M14-05: the command palette's read. `ticket:read` opens the door; each
 * section then asks for its own permission and is skipped, not refused, when
 * the person lacks it.
 */
@Controller('api/brands/:brandId/quick-search')
export class QuickSearchController {
  readonly #quickSearch: QuickSearchService;

  constructor(@Inject(QuickSearchService) quickSearch: QuickSearchService) {
    this.#quickSearch = quickSearch;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(QuickSearchDto)
  search(
    @Param(new ZodValidationPipe(QuickSearchBrandParamDto)) { brandId }: QuickSearchBrandParamDto,
    @Query(new ZodValidationPipe(QuickSearchQueryDto)) query: QuickSearchQueryDto,
  ): Promise<QuickSearch> {
    const { principal } = requireRequestContext();
    /* c8 ignore next 3 -- the guard refuses the request before a handler runs. */
    if (principal === null) {
      throw new Error('The authentication guard let an unauthenticated request through');
    }
    const can = (permission: Parameters<typeof principalHasPermission>[2]): boolean =>
      principalHasPermission(principal, brandId, permission);
    return this.#quickSearch.search(
      {
        brandId,
        viewerId: principalIdOf(principal),
        can: {
          tickets: can('ticket:read'),
          contacts: can('contact:read'),
          articles: can('help_center:read'),
          manageArticles: can('help_center:manage'),
        },
      },
      query,
    );
  }
}
