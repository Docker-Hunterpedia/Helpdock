import type {
  BrandSettings,
  TicketStatus,
  TicketStatusList,
  TicketStatusUsage,
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
  Patch,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../../context/request-context.js';
import { activityActorFor } from '../ticket-activity.js';
import {
  BrandSettingsDto,
  FeedbackSettingsUpdateRequestDto,
  ReplyBehaviourUpdateRequestDto,
  TicketingBrandParamDto,
  TicketStatusCreateRequestDto,
  TicketStatusDto,
  TicketStatusListDto,
  TicketStatusParamDto,
  TicketStatusReorderRequestDto,
  TicketStatusUpdateRequestDto,
  TicketStatusUsageDto,
} from './dto.js';
import {
  type TicketingSettingsContext,
  TicketingSettingsService,
} from './ticketing-settings.service.js';

/**
 * The Statuses tab and the Reply behaviour card of `Admin/Ticketing` (M1-08).
 *
 * **One permission, `ticketing:manage`, and it is new.** DOMAIN-RULES §1.2
 * gives a Team Leader "departments they lead: agents, SLAs, rules, macros,
 * canned responses, help center, widget theme, content policy, **reopen
 * policy**", and §2.3 repeats that the reopen policy is theirs. `brand:manage`
 * is Admin-only and carries the brand's time zone with it; `settings:write` is
 * install configuration. Neither says what this is, so this says it.
 *
 * The status **list** stays on `TicketsController` under `ticket:read`: every
 * agent draws a badge from it, and a second route answering the same question
 * would be a second answer to keep in step.
 *
 * **Every parameter names its schema**, for the reason `StaffController`'s
 * comment gives (`pnpm check:validation`).
 */
@Controller('api/brands/:brandId')
export class TicketingSettingsController {
  readonly #settings: TicketingSettingsService;

  constructor(@Inject(TicketingSettingsService) settings: TicketingSettingsService) {
    this.#settings = settings;
  }

  @Post('ticket-statuses')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TicketStatusDto)
  create(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(TicketStatusCreateRequestDto)) body: TicketStatusCreateRequestDto,
  ): Promise<TicketStatus> {
    return this.#settings.create(this.#context(), body);
  }

  /**
   * The whole list in its new order, which is what the drag handle and the
   * "Move up" / "Move down" row actions both send.
   *
   * Declared before `:statusId`, so `reorder` is never read as a status id.
   */
  @Post('ticket-statuses/reorder')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TicketStatusListDto)
  reorder(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(TicketStatusReorderRequestDto)) body: TicketStatusReorderRequestDto,
  ): Promise<TicketStatusList> {
    return this.#settings.reorder(this.#context(), body);
  }

  /**
   * What the delete confirmation prints before it asks: the count and where
   * they go.
   *
   * `brand:manage`, like the delete it precedes, and for the same reason — the
   * count is only true for a principal whose department scope is `'all'`.
   */
  @Get('ticket-statuses/:statusId/usage')
  @Requires('brand:manage')
  @ZodSerializerDto(TicketStatusUsageDto)
  usage(
    @Param(new ZodValidationPipe(TicketStatusParamDto)) { statusId }: TicketStatusParamDto,
  ): Promise<TicketStatusUsage> {
    return this.#settings.usage(getTx(), statusId);
  }

  @Patch('ticket-statuses/:statusId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TicketStatusDto)
  update(
    @Param(new ZodValidationPipe(TicketStatusParamDto)) { statusId }: TicketStatusParamDto,
    @Body(new ZodValidationPipe(TicketStatusUpdateRequestDto)) body: TicketStatusUpdateRequestDto,
  ): Promise<TicketStatus> {
    return this.#settings.update(this.#context(), statusId, body);
  }

  /**
   * **`brand:manage`, not `ticketing:manage`**, which is narrower than the rest
   * of this controller and deliberately so.
   *
   * Deleting a status moves every ticket that points at it, and `tickets` is
   * department-scoped: a Team Leader restricted to two departments would move
   * only their own tickets, leave the rest pointing at the row, and then be
   * refused by the foreign key. `brands/department-deletion.ts` reasons the
   * same way about deleting a department, and resolves it the same way — an
   * Admin's department scope is always `'all'`, so nobody who could be shown a
   * partial count is allowed to act on it.
   *
   * Everything else here stays `ticketing:manage`: `ticket_statuses` is
   * brand-scoped and never department-scoped, so creating, editing and
   * reordering have no such asymmetry.
   */
  @Delete('ticket-statuses/:statusId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(TicketStatusParamDto)) { statusId }: TicketStatusParamDto,
  ): Promise<void> {
    await this.#settings.remove(this.#context(), statusId);
  }

  /**
   * The two settings of DOMAIN-RULES §2.3 a Team Leader may change, and no
   * others. `PATCH /api/brands/:brandId` still writes the whole object, and
   * still needs `brand:manage`.
   */
  @Patch('ticketing/reply-behaviour')
  @Requires('ticketing:manage')
  @ZodSerializerDto(BrandSettingsDto)
  replyBehaviour(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(ReplyBehaviourUpdateRequestDto))
    body: ReplyBehaviourUpdateRequestDto,
  ): Promise<BrandSettings> {
    return this.#settings.updateReplyBehaviour(this.#context(), body);
  }

  /**
   * The Feedback tab (M1-12): CSAT, time tracking and the composer timer.
   * `ticketing:manage` for the reason the reply behaviour is: a Team Leader
   * shapes how their desk works, and the whole-brand `PATCH` is Admin-only.
   */
  @Patch('ticketing/feedback')
  @Requires('ticketing:manage')
  @ZodSerializerDto(BrandSettingsDto)
  feedback(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(FeedbackSettingsUpdateRequestDto))
    body: FeedbackSettingsUpdateRequestDto,
  ): Promise<BrandSettings> {
    return this.#settings.updateFeedback(this.#context(), body);
  }

  /**
   * The actor, built from the principal the guard resolved rather than from a
   * fresh read, for the reason `DepartmentsController` gives: the claims are
   * what the permission was checked against, and a second source would be a
   * second answer to "who is asking?".
   */
  #context(): TicketingSettingsContext {
    const request = requireRequestContext();
    const principal = request.principal;
    const brandId = request.targetBrandId;

    /* c8 ignore next 4 -- the permission guard has already refused anything else. */
    if (principal === null || brandId === null) {
      throw new Error('A ticketing-settings route ran without a principal in a brand');
    }

    return { tx: getTx(), brandId, actor: activityActorFor(principal), now: new Date() };
  }
}
