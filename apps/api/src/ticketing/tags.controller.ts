import type { TagList, TagSummary, TagUsage } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import {
  TagCreateRequestDto,
  TagListDto,
  TagParamDto,
  TagReorderRequestDto,
  TagSummaryDto,
  TagUpdateRequestDto,
  TagUsageDto,
  TicketingBrandParamDto,
} from './dto.js';
import { TagsService } from './tags.service.js';
import { requireTicketingContext } from './ticketing-context.js';

/**
 * The Tags tab of `Admin/Ticketing`, and the tag list every ticket screen
 * reads.
 *
 * **Two permissions, because there are two audiences.** Reading is
 * `ticket:read`: an Agent's chip picker and this settings tab are the same
 * list. Changing it is `ticketing:manage`, which DOMAIN-RULES §1.2 gives the
 * Admin and the Team Leader — a tag list is brand configuration, and an Agent
 * puts tags on tickets rather than inventing them.
 *
 * The usage count is its own route rather than a field on the list, because it
 * is only ever read once: immediately before the delete confirmation, so the
 * dialog can say what the delete costs.
 */
@Controller('api/brands/:brandId/tags')
export class TagsController {
  readonly #tags: TagsService;

  constructor(@Inject(TagsService) tags: TagsService) {
    this.#tags = tags;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TagListDto)
  list(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
  ): Promise<TagList> {
    return this.#tags.list(getTx());
  }

  @Post()
  @Requires('ticketing:manage')
  @ZodSerializerDto(TagSummaryDto)
  create(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(TagCreateRequestDto)) body: TagCreateRequestDto,
  ): Promise<TagSummary> {
    return this.#tags.create(requireTicketingContext(), body);
  }

  /** The whole list in its new order, as the departments tab reorders. */
  @Post('reorder')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TagListDto)
  reorder(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(TagReorderRequestDto)) body: TagReorderRequestDto,
  ): Promise<TagList> {
    return this.#tags.reorder(requireTicketingContext(), body);
  }

  /** What the delete confirmation reads: how many tickets keep no tag. */
  @Get(':tagId/usage')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TagUsageDto)
  usage(@Param(new ZodValidationPipe(TagParamDto)) { tagId }: TagParamDto): Promise<TagUsage> {
    return this.#tags.usage(getTx(), tagId);
  }

  @Patch(':tagId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TagSummaryDto)
  update(
    @Param(new ZodValidationPipe(TagParamDto)) { tagId }: TagParamDto,
    @Body(new ZodValidationPipe(TagUpdateRequestDto)) body: TagUpdateRequestDto,
  ): Promise<TagSummary> {
    return this.#tags.update(requireTicketingContext(), tagId, body);
  }

  @Delete(':tagId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param(new ZodValidationPipe(TagParamDto)) { tagId }: TagParamDto): Promise<void> {
    await this.#tags.remove(requireTicketingContext(), tagId);
  }
}
