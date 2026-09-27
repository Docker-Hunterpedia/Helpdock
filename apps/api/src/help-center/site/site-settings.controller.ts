import {
  type HcAppearance,
  type HcCustomCssResult,
  type HcHomeLayout,
  type HcLinks,
  type HcSite,
  type HcStaffPassResponse,
  hcAppearanceSchema,
  hcAppearanceUpdateRequestSchema,
  hcCustomCssResultSchema,
  hcCustomCssUpdateRequestSchema,
  hcHomeLayoutSchema,
  hcLinksSchema,
  hcSiteSchema,
  hcStaffPassRequestSchema,
  hcStaffPassResponseSchema,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../../auth/route-declaration.js';
import { bearerTokenOf, verifyAccessToken } from '../../auth/session/access-token.js';
import type { SigningKeys } from '../../auth/session/signing-keys.js';
import { HcBrandParamDto } from '../dto.js';
import { context } from '../help-center.controller.js';
import { HelpCenterSiteSettingsService } from './site-settings.service.js';
import { HelpCenterStaffPassService } from './staff-pass.service.js';

class HcSiteDto extends createZodDto(hcSiteSchema) {}
class HcAppearanceDto extends createZodDto(hcAppearanceSchema) {}
class HcAppearanceUpdateRequestDto extends createZodDto(hcAppearanceUpdateRequestSchema) {}
class HcHomeLayoutDto extends createZodDto(hcHomeLayoutSchema) {}
class HcLinksDto extends createZodDto(hcLinksSchema) {}
class HcCustomCssUpdateRequestDto extends createZodDto(hcCustomCssUpdateRequestSchema) {}
class HcCustomCssResultDto extends createZodDto(hcCustomCssResultSchema) {}
class HcStaffPassRequestDto extends createZodDto(hcStaffPassRequestSchema) {}
class HcStaffPassResponseDto extends createZodDto(hcStaffPassResponseSchema) {}

/** The session key, to read the refresh family out of the caller's access token. */
export const HC_SIGNING_KEYS = Symbol('HelpCenterSigningKeys');

/**
 * M5-06's cards on Help center › Settings, and M5-03's staff pass, over HTTP.
 * Reading is `help_center:read`; saving is `help_center:manage`, an Admin's
 * and a Team Leader's (DOMAIN-RULES §1.2). The staff pass is
 * `help_center:read`: every role may read the brand's help center as staff.
 */
@Controller('api/brands/:brandId/help-center')
export class HelpCenterSiteSettingsController {
  readonly #settings: HelpCenterSiteSettingsService;
  readonly #passes: HelpCenterStaffPassService;
  readonly #keys: SigningKeys;

  constructor(
    @Inject(HelpCenterSiteSettingsService) settings: HelpCenterSiteSettingsService,
    @Inject(HelpCenterStaffPassService) passes: HelpCenterStaffPassService,
    @Inject(HC_SIGNING_KEYS) keys: SigningKeys,
  ) {
    this.#settings = settings;
    this.#passes = passes;
    this.#keys = keys;
  }

  @Get('site')
  @Requires('help_center:read')
  @ZodSerializerDto(HcSiteDto)
  site(@Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto): Promise<HcSite> {
    return this.#settings.get(context());
  }

  @Put('site/appearance')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcAppearanceDto)
  appearance(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcAppearanceUpdateRequestDto)) body: HcAppearanceUpdateRequestDto,
  ): Promise<HcAppearance> {
    return this.#settings.updateAppearance(context(), body);
  }

  @Put('site/home')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcHomeLayoutDto)
  home(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcHomeLayoutDto)) body: HcHomeLayoutDto,
  ): Promise<HcHomeLayout> {
    return this.#settings.updateHome(context(), body);
  }

  @Put('site/links')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcLinksDto)
  links(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcLinksDto)) body: HcLinksDto,
  ): Promise<HcLinks> {
    return this.#settings.updateLinks(context(), body);
  }

  @Put('site/custom-css')
  @Requires('help_center:manage')
  @ZodSerializerDto(HcCustomCssResultDto)
  customCss(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcCustomCssUpdateRequestDto)) body: HcCustomCssUpdateRequestDto,
  ): Promise<HcCustomCssResult> {
    return this.#settings.updateCustomCss(context(), body);
  }

  @Post('staff-pass')
  @HttpCode(HttpStatus.OK)
  @Requires('help_center:read')
  @ZodSerializerDto(HcStaffPassResponseDto)
  async staffPass(
    @Param(new ZodValidationPipe(HcBrandParamDto)) _params: HcBrandParamDto,
    @Body(new ZodValidationPipe(HcStaffPassRequestDto)) body: HcStaffPassRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<HcStaffPassResponse> {
    const familyId = await refreshFamilyOf(request, this.#keys);
    return this.#passes.issue(context(), familyId, body);
  }
}

/**
 * The refresh family of the admin session behind this request. The route is
 * already authorised by `@Requires`; this only reads which browser it came
 * from. A principal that is not a browser session (the dev header, an api
 * key) has no refresh family for the help center's cookie to follow.
 */
const refreshFamilyOf = async (request: FastifyRequest, keys: SigningKeys): Promise<string> => {
  const token = bearerTokenOf(request.headers.authorization);
  const claims = token === null ? null : await verifyAccessToken(token, keys);
  if (claims === null) {
    throw new ForbiddenException('The help center is opened from a signed-in admin session');
  }
  return claims.fam;
};
