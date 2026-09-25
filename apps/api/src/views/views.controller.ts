import type { TicketView, TicketViewCountList, TicketViewList } from '@helpdock/schemas';
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
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  TicketViewCountListDto,
  TicketViewCreateRequestDto,
  TicketViewDto,
  TicketViewListDto,
  TicketViewParamDto,
  TicketViewReorderRequestDto,
  TicketViewUpdateRequestDto,
  ViewsBrandParamDto,
} from './dto.js';
import { type ViewsContext, ViewsService } from './views.service.js';

/**
 * The sidebar's Views group, the list header's "Save as a view", and the
 * Views tab of `Admin/Ticketing` (M1-05).
 *
 * **Every route is `ticket:read`**, because every reader of tickets may keep
 * personal views. What a shared view needs on top — `ticketing:manage`, and
 * for a Team Leader the departments it reaches — is decided in the service by
 * `view-rules.ts`, the way erasing a contact is narrowed past its route's
 * permission: one route per action, and the rule where the view is known.
 *
 * The counts are their own route: the Views tab needs the list and not the
 * counts, and the sidebar can draw its names before the numbers arrive.
 */
@Controller('api/brands/:brandId/views')
export class ViewsController {
  readonly #views: ViewsService;

  constructor(@Inject(ViewsService) views: ViewsService) {
    this.#views = views;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TicketViewListDto)
  list(
    @Param(new ZodValidationPipe(ViewsBrandParamDto)) _params: ViewsBrandParamDto,
  ): Promise<TicketViewList> {
    return this.#views.list(requireViewsContext());
  }

  @Get('counts')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketViewCountListDto)
  counts(
    @Param(new ZodValidationPipe(ViewsBrandParamDto)) _params: ViewsBrandParamDto,
  ): Promise<TicketViewCountList> {
    return this.#views.counts(requireViewsContext());
  }

  @Post()
  @Requires('ticket:read')
  @ZodSerializerDto(TicketViewDto)
  create(
    @Param(new ZodValidationPipe(ViewsBrandParamDto)) _params: ViewsBrandParamDto,
    @Body(new ZodValidationPipe(TicketViewCreateRequestDto)) body: TicketViewCreateRequestDto,
  ): Promise<TicketView> {
    return this.#views.create(requireViewsContext(), body);
  }

  /** Some views in a new order: all shared, or all the reader's own. */
  @Post('reorder')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketViewListDto)
  reorder(
    @Param(new ZodValidationPipe(ViewsBrandParamDto)) _params: ViewsBrandParamDto,
    @Body(new ZodValidationPipe(TicketViewReorderRequestDto)) body: TicketViewReorderRequestDto,
  ): Promise<TicketViewList> {
    return this.#views.reorder(requireViewsContext(), body);
  }

  @Patch(':viewId')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketViewDto)
  update(
    @Param(new ZodValidationPipe(TicketViewParamDto)) { viewId }: TicketViewParamDto,
    @Body(new ZodValidationPipe(TicketViewUpdateRequestDto)) body: TicketViewUpdateRequestDto,
  ): Promise<TicketView> {
    return this.#views.update(requireViewsContext(), viewId, body);
  }

  @Delete(':viewId')
  @Requires('ticket:read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(TicketViewParamDto)) { viewId }: TicketViewParamDto,
  ): Promise<void> {
    await this.#views.remove(requireViewsContext(), viewId);
  }
}

/**
 * The request's transaction, brand and staff actor. An api key may hold
 * `ticket:read` too (M8-01), but a view is a person's — "mine", "me", "only
 * me" — so anything but a staff principal is refused here rather than given a
 * sidebar nobody owns.
 */
const requireViewsContext = (): ViewsContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;
  const membership =
    principal?.type === 'staff' && brandId !== null ? principal.brands[brandId] : undefined;

  if (principal?.type !== 'staff' || brandId === null || membership === undefined) {
    throw new ForbiddenException('Views belong to staff');
  }

  return {
    tx: getTx(),
    brandId,
    actor: {
      userId: principal.id,
      role: membership.role,
      departmentIds: membership.departmentIds,
    },
  };
};
