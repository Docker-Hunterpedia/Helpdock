import type { TicketTemplate, TicketTemplateList, TicketTemplatePreview } from '@helpdock/schemas';
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
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  TicketingBrandParamDto,
  TicketTemplateCreateRequestDto,
  TicketTemplateDto,
  TicketTemplateListDto,
  TicketTemplateParamDto,
  TicketTemplatePreviewDto,
  TicketTemplatePreviewQueryDto,
  TicketTemplateUpdateRequestDto,
} from './dto.js';
import { TemplatesService } from './templates.service.js';
import { requireTicketingContext } from './ticketing-context.js';

/**
 * The Templates tab of `Admin/Ticketing`, and the template picker on the create
 * screen.
 *
 * Reading is `ticket:write` rather than `ticket:read`: a template is only ever
 * read in order to file a ticket with it, and a Viewer — who may read tickets
 * and write none — has nothing to do with the list.
 *
 * The preview is a read that renders placeholders. It is on this controller
 * rather than in the editor's browser because the renderer decides what a
 * placeholder may reach, and a second implementation in TypeScript would be a
 * second answer to that (`template-render.ts`).
 */
@Controller('api/brands/:brandId/ticket-templates')
export class TemplatesController {
  readonly #templates: TemplatesService;

  constructor(@Inject(TemplatesService) templates: TemplatesService) {
    this.#templates = templates;
  }

  @Get()
  @Requires('ticket:write')
  @ZodSerializerDto(TicketTemplateListDto)
  list(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
  ): Promise<TicketTemplateList> {
    return this.#templates.list(getTx());
  }

  @Post()
  @Requires('ticketing:manage')
  @ZodSerializerDto(TicketTemplateDto)
  create(
    @Param(new ZodValidationPipe(TicketingBrandParamDto)) _params: TicketingBrandParamDto,
    @Body(new ZodValidationPipe(TicketTemplateCreateRequestDto))
    body: TicketTemplateCreateRequestDto,
  ): Promise<TicketTemplate> {
    return this.#templates.create(requireTicketingContext(), body);
  }

  @Get(':templateId')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketTemplateDto)
  find(
    @Param(new ZodValidationPipe(TicketTemplateParamDto)) { templateId }: TicketTemplateParamDto,
  ): Promise<TicketTemplate> {
    return this.#templates.find(getTx(), templateId);
  }

  @Get(':templateId/preview')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketTemplatePreviewDto)
  preview(
    @Param(new ZodValidationPipe(TicketTemplateParamDto)) { templateId }: TicketTemplateParamDto,
    @Query(new ZodValidationPipe(TicketTemplatePreviewQueryDto))
    query: TicketTemplatePreviewQueryDto,
  ): Promise<TicketTemplatePreview> {
    return this.#templates.preview(getTx(), this.#brandId(), templateId, query.contactId);
  }

  @Patch(':templateId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(TicketTemplateDto)
  update(
    @Param(new ZodValidationPipe(TicketTemplateParamDto)) { templateId }: TicketTemplateParamDto,
    @Body(new ZodValidationPipe(TicketTemplateUpdateRequestDto))
    body: TicketTemplateUpdateRequestDto,
  ): Promise<TicketTemplate> {
    return this.#templates.update(requireTicketingContext(), templateId, body);
  }

  @Delete(':templateId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(TicketTemplateParamDto)) { templateId }: TicketTemplateParamDto,
  ): Promise<void> {
    await this.#templates.remove(requireTicketingContext(), templateId);
  }

  /**
   * The brand the guard resolved, not the one in the path. They are the same
   * string; taking it from the request is what makes that true rather than
   * assumed.
   */
  #brandId(): string {
    const brandId = requireRequestContext().targetBrandId;
    /* c8 ignore next 3 -- a permission route always has a target brand. */
    if (brandId === null) {
      throw new Error('A ticketing route ran without a target brand');
    }

    return brandId;
  }
}
