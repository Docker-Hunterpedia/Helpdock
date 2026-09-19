import type { Brand, BrandList } from '@helpdock/schemas';
import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { brandsOf } from '../auth/principal.js';
import { Authenticated, Requires } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { BrandsService } from './brands.service.js';
import { BrandDto, BrandIdParamDto, BrandListDto } from './dto.js';

/**
 * Three thin reads that exercise every branch of the tenancy plumbing: a route
 * scoped to the principal, a route scoped to one brand, and an install-scope
 * route. They are the smallest thing that can prove the middleware, the guards
 * and the interceptor agree with each other.
 */
@Controller('api')
export class BrandsController {
  readonly #brands: BrandsService;

  constructor(@Inject(BrandsService) brands: BrandsService) {
    this.#brands = brands;
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
}
