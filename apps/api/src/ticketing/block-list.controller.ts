import type { BlockedSender, BlockedSenderList, BrandSettings } from '@helpdock/schemas';
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
import { BlockListService } from './block-list.service.js';
import {
  BlockedSenderCreateRequestDto,
  BlockedSenderDto,
  BlockedSenderListDto,
  BlockedSenderParamDto,
  SpamSettingsDto,
  SpamSettingsUpdateRequestDto,
  TicketingBrandParamDto,
} from './dto.js';
import { requireTicketingContext } from './ticketing-context.js';

/**
 * The Spam tab of `Admin/Ticketing` (M1-11): the sender block list and the
 * "Offer 'Block sender'" setting.
 *
 * **`ticketing:manage` throughout**, reading included. The list is not
 * something an Agent works from — an Agent blocks a sender through "Mark as
 * spam", which is `ticket:write` and lives on the ticket routes — and the
 * values are other people's addresses, which a Viewer has no reason to read.
 */
@Controller('api/brands/:brandId')
export class BlockListController {
  readonly #blockList: BlockListService;

  constructor(@Inject(BlockListService) blockList: BlockListService) {
    this.#blockList = blockList;
  }

  @Get('blocked-senders')
  @Requires('ticketing:manage')
  @ZodSerializerDto(BlockedSenderListDto)
  list(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
  ): Promise<BlockedSenderList> {
    return this.#blockList.list(getTx());
  }

  @Post('blocked-senders')
  @Requires('ticketing:manage')
  @ZodSerializerDto(BlockedSenderDto)
  create(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(BlockedSenderCreateRequestDto))
    body: BlockedSenderCreateRequestDto,
  ): Promise<BlockedSender> {
    return this.#blockList.create(requireTicketingContext(), body);
  }

  /** "Unblock". The counter goes with it, into the audit row. */
  @Delete('blocked-senders/:blockedSenderId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(BlockedSenderParamDto)) { blockedSenderId }: BlockedSenderParamDto,
  ): Promise<void> {
    await this.#blockList.remove(requireTicketingContext(), blockedSenderId);
  }

  /**
   * The Spam tab's settings card. Its own narrow body, for the reason the reply
   * behaviour route gives: `PATCH /api/brands/:brandId` is Admin-only and
   * carries the time zone.
   */
  @Patch('ticketing/spam-settings')
  @Requires('ticketing:manage')
  @ZodSerializerDto(SpamSettingsDto)
  updateSettings(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(SpamSettingsUpdateRequestDto)) body: SpamSettingsUpdateRequestDto,
  ): Promise<BrandSettings> {
    return this.#blockList.updateSettings(requireTicketingContext(), body);
  }
}
