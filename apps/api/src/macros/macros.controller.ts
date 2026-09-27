import type { Macro, MacroList, MacroRunResponse, RenderedMacro } from '@helpdock/schemas';
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
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { CannedResponsesService } from './canned-responses.service.js';
import {
  MacroCreateRequestDto,
  MacroDto,
  MacroListDto,
  MacroListQueryDto,
  MacroParamDto,
  MacroRenderQueryDto,
  MacroRunParamDto,
  MacroRunRequestDto,
  MacroRunResponseDto,
  MacrosBrandParamDto,
  MacroTicketParamDto,
  MacroUpdateRequestDto,
  RenderedMacroDto,
} from './dto.js';
import { MacroRunService } from './macro-run.service.js';
import { type MacrosContext, MacrosService } from './macros.service.js';

/**
 * M3-06 over HTTP: the Macros tab of Automation, and the composer's picker.
 *
 * **Reading is `ticket:read`; everything else is `ticket:write`**, because
 * anybody who replies may keep personal macros. What a *shared* one needs on
 * top — an Admin, or a Team Leader of its department — is decided in the
 * service by `macro-rules.ts`, where the item is known, as views do.
 */
@Controller('api/brands/:brandId')
export class MacrosController {
  readonly #macros: MacrosService;
  readonly #canned: CannedResponsesService;
  readonly #runs: MacroRunService;

  constructor(
    @Inject(MacrosService) macros: MacrosService,
    @Inject(CannedResponsesService) canned: CannedResponsesService,
    @Inject(MacroRunService) runs: MacroRunService,
  ) {
    this.#macros = macros;
    this.#canned = canned;
    this.#runs = runs;
  }

  @Get('macros')
  @Requires('ticket:read')
  @ZodSerializerDto(MacroListDto)
  list(
    @Param(new ZodValidationPipe(MacrosBrandParamDto)) _params: MacrosBrandParamDto,
    @Query(new ZodValidationPipe(MacroListQueryDto)) query: MacroListQueryDto,
  ): Promise<MacroList> {
    return this.#macros.list(requireMacrosContext(), query);
  }

  @Post('macros')
  @Requires('ticket:write')
  @ZodSerializerDto(MacroDto)
  create(
    @Param(new ZodValidationPipe(MacrosBrandParamDto)) _params: MacrosBrandParamDto,
    @Body(new ZodValidationPipe(MacroCreateRequestDto)) body: MacroCreateRequestDto,
  ): Promise<Macro> {
    return this.#macros.create(requireMacrosContext(), body);
  }

  @Patch('macros/:macroId')
  @Requires('ticket:write')
  @ZodSerializerDto(MacroDto)
  update(
    @Param(new ZodValidationPipe(MacroParamDto)) { macroId }: MacroParamDto,
    @Body(new ZodValidationPipe(MacroUpdateRequestDto)) body: MacroUpdateRequestDto,
  ): Promise<Macro> {
    return this.#macros.update(requireMacrosContext(), macroId, body);
  }

  @Delete('macros/:macroId')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(MacroParamDto)) { macroId }: MacroParamDto,
  ): Promise<void> {
    await this.#macros.remove(requireMacrosContext(), macroId);
  }

  /**
   * One filled in for a ticket, signed by whoever is asking. A read: the
   * picker previews every item the selection passes over, and none of that is
   * "using" one — sending the reply is (`macro-runs`).
   */
  @Get('tickets/:ticketId/macros/:macroId/render')
  @Requires('ticket:write')
  @ZodSerializerDto(RenderedMacroDto)
  async render(
    @Param(new ZodValidationPipe(MacroTicketParamDto)) { ticketId, macroId }: MacroTicketParamDto,
    @Query(new ZodValidationPipe(MacroRenderQueryDto)) query: MacroRenderQueryDto,
  ): Promise<RenderedMacro> {
    const context = requireMacrosContext();
    await this.#macros.assertUsable(context, macroId, ticketId);

    return this.#canned.render(macroId, {
      locale: query.locale,
      ticket: { id: ticketId },
      agent: { id: context.actor.userId },
    });
  }

  @Post('tickets/:ticketId/macro-runs')
  @Requires('ticket:write')
  @ZodSerializerDto(MacroRunResponseDto)
  run(
    @Param(new ZodValidationPipe(MacroRunParamDto)) { brandId, ticketId }: MacroRunParamDto,
    @Body(new ZodValidationPipe(MacroRunRequestDto)) body: MacroRunRequestDto,
  ): Promise<MacroRunResponse> {
    const { actor } = requireMacrosContext();

    return this.#runs.run(brandId, staffPrincipal(), actor, ticketId, body);
  }
}

const staffPrincipal = (): Principal => {
  const principal = requireRequestContext().principal;
  /* c8 ignore next 3 -- `requireMacrosContext` has already refused anything but staff. */
  if (principal === null) {
    throw new ForbiddenException('Macros belong to staff');
  }

  return principal;
};

/**
 * The request's transaction, brand and staff actor. An api key may hold
 * `ticket:write` too (M8-01), but a macro is a person's tool — "only me",
 * "the agent applying it" — so anything but a staff principal is refused here.
 */
const requireMacrosContext = (): MacrosContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;
  const membership =
    principal?.type === 'staff' && brandId !== null ? principal.brands[brandId] : undefined;

  if (principal?.type !== 'staff' || brandId === null || membership === undefined) {
    throw new ForbiddenException('Macros belong to staff');
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
