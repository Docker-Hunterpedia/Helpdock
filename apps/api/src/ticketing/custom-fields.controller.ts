import type { CustomFieldDef, CustomFieldDefList, CustomFieldUsage } from '@helpdock/schemas';
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
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { CustomFieldsService } from './custom-fields.service.js';
import {
  CustomFieldCreateRequestDto,
  CustomFieldDefDto,
  CustomFieldDefListDto,
  CustomFieldParamDto,
  CustomFieldQueryDto,
  CustomFieldReorderRequestDto,
  CustomFieldUpdateRequestDto,
  CustomFieldUsageDto,
  TicketingBrandParamDto,
} from './dto.js';
import { requireTicketingContext } from './ticketing-context.js';

/**
 * The Custom fields tab of `Admin/Ticketing`, and the definitions the ticket,
 * contact and account screens draw their extra fields from.
 *
 * Reading is `ticket:read`, for the reason the tag list is: the details panel
 * renders the fields and needs to know what they are. Changing them is
 * `ticketing:manage`.
 *
 * `usage` is its own route because it is read at exactly two moments — before a
 * delete, and after an option removal is refused — and putting a count of three
 * tables' rows on every list read would be three counts per field per render.
 */
@Controller('api/brands/:brandId/custom-fields')
export class CustomFieldsController {
  readonly #fields: CustomFieldsService;

  constructor(@Inject(CustomFieldsService) fields: CustomFieldsService) {
    this.#fields = fields;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(CustomFieldDefListDto)
  list(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Query(new ZodValidationPipe(CustomFieldQueryDto)) query: CustomFieldQueryDto,
  ): Promise<CustomFieldDefList> {
    return this.#fields.list(getTx(), query.target);
  }

  @Post()
  @Requires('ticketing:manage')
  @ZodSerializerDto(CustomFieldDefDto)
  create(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(CustomFieldCreateRequestDto)) body: CustomFieldCreateRequestDto,
  ): Promise<CustomFieldDef> {
    return this.#fields.create(requireTicketingContext(), body);
  }

  /** The whole list of one target in its new order. */
  @Post('reorder')
  @Requires('ticketing:manage')
  @ZodSerializerDto(CustomFieldDefListDto)
  reorder(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(CustomFieldReorderRequestDto)) body: CustomFieldReorderRequestDto,
  ): Promise<CustomFieldDefList> {
    return this.#fields.reorder(requireTicketingContext(), body);
  }

  /** How many rows carry a value, and how many carry each option. */
  @Get(':fieldId/usage')
  @Requires('ticketing:manage')
  @ZodSerializerDto(CustomFieldUsageDto)
  usage(
    @Param(new ZodValidationPipe(CustomFieldParamDto)) { fieldId }: CustomFieldParamDto,
  ): Promise<CustomFieldUsage> {
    return this.#fields.usage(getTx(), fieldId);
  }

  @Patch(':fieldId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(CustomFieldDefDto)
  update(
    @Param(new ZodValidationPipe(CustomFieldParamDto)) { fieldId }: CustomFieldParamDto,
    @Body(new ZodValidationPipe(CustomFieldUpdateRequestDto)) body: CustomFieldUpdateRequestDto,
  ): Promise<CustomFieldDef> {
    return this.#fields.update(requireTicketingContext(), fieldId, body);
  }

  @Delete(':fieldId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(CustomFieldParamDto)) { fieldId }: CustomFieldParamDto,
  ): Promise<void> {
    await this.#fields.remove(requireTicketingContext(), fieldId);
  }
}
