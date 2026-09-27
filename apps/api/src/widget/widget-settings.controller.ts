import type { WidgetSettings, WidgetSigningSecret } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { principalHasPermission } from '../auth/permissions.js';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  WidgetAccessUpdateDto,
  WidgetAdminParamDto,
  WidgetAppearanceDto,
  WidgetContentPolicyDto,
  WidgetConversationSettingsDto,
  WidgetSettingsDto,
  WidgetSignedIdentityDto,
  WidgetSigningSecretDto,
} from './dto.js';
import { type WidgetAdminContext, WidgetSettingsService } from './widget-settings.service.js';

const context = (brandId: string): WidgetAdminContext => {
  const principal = requireRequestContext().principal;
  const actorId = requireStaffPrincipalId(principal);
  /* c8 ignore next -- `requireStaffPrincipalId` has already refused a null one. */
  const isAdmin = principal !== null && principalHasPermission(principal, brandId, 'brand:manage');

  return { tx: getTx(), brandId, actorId, isAdmin, now: new Date() };
};

/**
 * Channels › Widget (artboard `AdminWidget`). DOMAIN-RULES §1.2 gives the
 * Team Leader "widget theme, content policy" and keeps brand-wide access with
 * the Admin, so the three cards a Team Leader sees are `ticketing:manage`
 * (Admin and Team Leader) and the two Admin-only cards are `brand:manage`.
 */
@Controller('api/brands/:brandId/widget')
export class WidgetSettingsController {
  readonly #settings: WidgetSettingsService;

  constructor(@Inject(WidgetSettingsService) settings: WidgetSettingsService) {
    this.#settings = settings;
  }

  @Get('settings')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WidgetSettingsDto)
  view(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
  ): Promise<WidgetSettings> {
    return this.#settings.view(context(brandId));
  }

  @Put('appearance')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WidgetSettingsDto)
  saveAppearance(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
    @Body(new ZodValidationPipe(WidgetAppearanceDto)) body: WidgetAppearanceDto,
  ): Promise<WidgetSettings> {
    return this.#settings.saveAppearance(context(brandId), body);
  }

  @Put('conversation')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WidgetSettingsDto)
  saveConversation(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
    @Body(new ZodValidationPipe(WidgetConversationSettingsDto)) body: WidgetConversationSettingsDto,
  ): Promise<WidgetSettings> {
    return this.#settings.saveConversation(context(brandId), body);
  }

  @Put('content-policy')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WidgetSettingsDto)
  saveContentPolicy(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
    @Body(new ZodValidationPipe(WidgetContentPolicyDto)) body: WidgetContentPolicyDto,
  ): Promise<WidgetSettings> {
    return this.#settings.saveContentPolicy(context(brandId), body);
  }

  @Put('access')
  @Requires('brand:manage')
  @ZodSerializerDto(WidgetSettingsDto)
  saveAccess(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
    @Body(new ZodValidationPipe(WidgetAccessUpdateDto)) body: WidgetAccessUpdateDto,
  ): Promise<WidgetSettings> {
    return this.#settings.saveAccess(context(brandId), body);
  }

  @Put('signed-identity')
  @Requires('brand:manage')
  @ZodSerializerDto(WidgetSettingsDto)
  saveSignedIdentity(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
    @Body(new ZodValidationPipe(WidgetSignedIdentityDto)) body: WidgetSignedIdentityDto,
  ): Promise<WidgetSettings> {
    return this.#settings.saveSignedIdentity(context(brandId), body);
  }

  /** The new secret, in this response only. */
  @Post('signing-secret')
  @Requires('brand:manage')
  @ZodSerializerDto(WidgetSigningSecretDto)
  replaceSigningSecret(
    @Param(new ZodValidationPipe(WidgetAdminParamDto)) { brandId }: WidgetAdminParamDto,
  ): Promise<WidgetSigningSecret> {
    return this.#settings.replaceSigningSecret(context(brandId));
  }
}
