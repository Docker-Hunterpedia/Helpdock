import type { Brand, BrandList } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { brandsOf, requireStaffPrincipalId } from '../auth/principal.js';
import { Authenticated, Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { BrandsService } from './brands.service.js';
import {
  BrandCreateRequestDto,
  BrandDto,
  BrandIdParamDto,
  BrandListDto,
  BrandUpdateRequestDto,
} from './dto.js';
import { InstallBrandsService } from './install-brands.service.js';

/**
 * The brand itself: the three reads M0-04 used to prove the tenancy plumbing —
 * a route scoped to the principal, a route scoped to one brand, and an
 * install-scope route — plus the two writes M1-01 adds.
 *
 * **Every parameter names its schema**, as `StaffController` does and for the
 * reason its comment gives: the global pipe finds a DTO through
 * `design:paramtypes`, which a build that drops decorator metadata does not
 * emit. Naming the pipe at the call site is the same validation, decided where
 * it can be read (`pnpm check:validation`).
 */
@Controller('api')
export class BrandsController {
  readonly #brands: BrandsService;
  readonly #install: InstallBrandsService;

  constructor(
    @Inject(BrandsService) brands: BrandsService,
    @Inject(InstallBrandsService) install: InstallBrandsService,
  ) {
    this.#brands = brands;
    this.#install = install;
  }

  /** The brands this principal holds a role in — not every brand it can name. */
  @Get('brands')
  @Authenticated()
  @ZodSerializerDto(BrandListDto)
  async list(): Promise<BrandList> {
    const principal = requireRequestContext().principal;
    /* c8 ignore next 3 -- the guard refuses the request before this can happen. */
    if (principal === null) {
      throw new Error('The authentication guard let an unauthenticated request through');
    }

    return { brands: await this.#brands.listOwnedBy(brandsOf(principal)) };
  }

  /**
   * Every brand in the install. This is the "all brands" path of DOMAIN-RULES
   * §1.1: only `installAdmin` reaches it, it runs in install scope, and the
   * interceptor writes an `install.scope.access` audit row before the handler
   * sees the transaction.
   */
  @Get('install/brands')
  @Requires('install:admin')
  @ZodSerializerDto(BrandListDto)
  async listAll(): Promise<BrandList> {
    return { brands: await this.#brands.listAll() };
  }

  /**
   * A second, third, tenth brand on a running install (M1-01). Install-admin
   * only, for the same reason the wizard's brand step is not a staff route: a
   * brand is the tenant boundary, and creating one hands whoever asked an
   * administrator's role in it.
   */
  @Post('install/brands')
  @Requires('install:admin')
  @ZodSerializerDto(BrandDto)
  create(
    @Body(new ZodValidationPipe(BrandCreateRequestDto)) body: BrandCreateRequestDto,
  ): Promise<Brand> {
    return this.#install.create({
      tx: getTx(),
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
      request: body,
    });
  }

  @Get('brands/:brandId')
  @Requires('brand:read')
  @ZodSerializerDto(BrandDto)
  async find(
    @Param(new ZodValidationPipe(BrandIdParamDto)) { brandId }: BrandIdParamDto,
  ): Promise<Brand> {
    const brand = await this.#brands.find(brandId);
    if (brand === undefined) {
      throw new NotFoundException('No such brand');
    }

    return brand;
  }

  /**
   * The brand's name, default locale, time zone and ticketing settings.
   *
   * `brand:manage`, which only an Admin holds: DOMAIN-RULES §1.2 gives a Team
   * Leader "departments they lead", not the brand. The one field in `settings`
   * §2.3 says a Team Leader may also set — the reopen policy — gets its own
   * Team-Leader-reachable route in M1-08, where the policy is acted on; putting
   * the whole object behind `staff:manage` here would hand them the time zone
   * with it.
   */
  @Patch('brands/:brandId')
  @Requires('brand:manage')
  @ZodSerializerDto(BrandDto)
  update(
    @Param(new ZodValidationPipe(BrandIdParamDto)) { brandId }: BrandIdParamDto,
    @Body(new ZodValidationPipe(BrandUpdateRequestDto)) body: BrandUpdateRequestDto,
  ): Promise<Brand> {
    return this.#brands.update(
      getTx(),
      { brandId, actorId: requireStaffPrincipalId(requireRequestContext().principal) },
      body,
    );
  }
}
