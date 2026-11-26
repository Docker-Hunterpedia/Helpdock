import type {
  AccountPortal,
  ContactPortalAccess,
  ContactPortalSignOut,
  PortalSettings,
  TicketPortalView,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  AccountPortalDto,
  AccountPortalUpdateDto,
  ContactPortalAccessDto,
  ContactPortalSignOutDto,
  PortalAccountParamDto,
  PortalBrandParamDto,
  PortalContactParamDto,
  PortalSettingsDto,
  PortalSettingsUpdateDto,
  PortalTicketParamDto,
  TicketPortalPrivateUpdateDto,
  TicketPortalViewDto,
} from './dto.js';
import { type PortalAdminContext, PortalAdminService } from './portal-admin.service.js';

/**
 * The staff side of the customer portal (M21-06). Permissions, in the words of
 * DOMAIN-RULES §1.2:
 *
 * - the brand's setting is `brand:manage`, as every page under Settings ›
 *   Channels (an Admin's);
 * - an account's visibility and managers, and signing a contact out, are
 *   `contact:write`, like every edit of a contact or an account; reading them is
 *   `contact:read`;
 * - the private mark is `ticket:write`, inside the agent's departments.
 *
 * `PATCH /api/brands/:brandId` still replaces the whole `settings` and is not
 * how the portal is configured: it has this narrow route, as the reply
 * behaviour, feedback and priority labels have theirs.
 *
 * **Every parameter names its schema**, for the reason `StaffController`'s
 * comment gives (`pnpm check:validation`).
 */
@Controller('api/brands/:brandId')
export class PortalAdminController {
  readonly #portal: PortalAdminService;

  constructor(@Inject(PortalAdminService) portal: PortalAdminService) {
    this.#portal = portal;
  }

  @Put('portal-settings')
  @Requires('brand:manage')
  @ZodSerializerDto(PortalSettingsDto)
  settings(
    @Param(new ZodValidationPipe(PortalBrandParamDto)) _params: PortalBrandParamDto,
    @Body(new ZodValidationPipe(PortalSettingsUpdateDto)) body: PortalSettingsUpdateDto,
  ): Promise<PortalSettings> {
    return this.#portal.updateSettings(this.#context(), body);
  }

  @Get('accounts/:accountId/portal')
  @Requires('contact:read')
  @ZodSerializerDto(AccountPortalDto)
  accountPortal(
    @Param(new ZodValidationPipe(PortalAccountParamDto)) { accountId }: PortalAccountParamDto,
  ): Promise<AccountPortal> {
    return this.#portal.accountPortal(this.#context(), accountId);
  }

  @Put('accounts/:accountId/portal')
  @Requires('contact:write')
  @ZodSerializerDto(AccountPortalDto)
  updateAccountPortal(
    @Param(new ZodValidationPipe(PortalAccountParamDto)) { accountId }: PortalAccountParamDto,
    @Body(new ZodValidationPipe(AccountPortalUpdateDto)) body: AccountPortalUpdateDto,
  ): Promise<AccountPortal> {
    return this.#portal.updateAccountPortal(this.#context(), accountId, body);
  }

  @Get('contacts/:contactId/portal')
  @Requires('contact:read')
  @ZodSerializerDto(ContactPortalAccessDto)
  contactAccess(
    @Param(new ZodValidationPipe(PortalContactParamDto)) { contactId }: PortalContactParamDto,
  ): Promise<ContactPortalAccess> {
    return this.#portal.contactAccess(this.#context(), contactId);
  }

  @Post('contacts/:contactId/portal/sign-out')
  @HttpCode(HttpStatus.OK)
  @Requires('contact:write')
  @ZodSerializerDto(ContactPortalSignOutDto)
  signOut(
    @Param(new ZodValidationPipe(PortalContactParamDto)) { contactId }: PortalContactParamDto,
  ): Promise<ContactPortalSignOut> {
    return this.#portal.signOut(this.#context(), contactId);
  }

  @Put('tickets/:ticketId/portal-private')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketPortalViewDto)
  portalPrivate(
    @Param(new ZodValidationPipe(PortalTicketParamDto)) { ticketId }: PortalTicketParamDto,
    @Body(new ZodValidationPipe(TicketPortalPrivateUpdateDto)) body: TicketPortalPrivateUpdateDto,
  ): Promise<TicketPortalView> {
    return this.#portal.setPortalPrivate(this.#context(), ticketId, body.private);
  }

  /** Built from the principal the guard resolved, for the reason `ContactsController`'s context is. */
  #context(): PortalAdminContext {
    const request = requireRequestContext();
    const principal = request.principal;
    const brandId = request.targetBrandId;

    /* c8 ignore next 3 -- the permission guard has already refused anything else. */
    if (principal === null || brandId === null) {
      throw new Error('A portal route ran without a principal in a brand');
    }

    return { tx: getTx(), brandId, principal, actorId: requireStaffPrincipalId(principal) };
  }
}
