import {
  type CustomDomain,
  type CustomDomainList,
  type CustomDomainUpdateRequest,
  customDomainUpdateRequestSchema,
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
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { DomainsService } from './domains.service.js';
import {
  DomainCreateRequestDto,
  DomainDto,
  DomainListDto,
  DomainParamDto,
  DomainsBrandParamDto,
} from './dto.js';

/**
 * Brand › Domains (M5-07): a brand's custom help center domains.
 *
 * **`brand:manage` throughout**, reading included. A hostname decides where a
 * brand's help center answers and who gets a certificate for it, which
 * DOMAIN-RULES §1.2 keeps with the Admin ("everything in the brand"); a Team
 * Leader's "departments they lead" does not reach it.
 */
@Controller('api/brands/:brandId/domains')
export class DomainsController {
  readonly #domains: DomainsService;

  constructor(@Inject(DomainsService) domains: DomainsService) {
    this.#domains = domains;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(DomainListDto)
  list(
    @Param(new ZodValidationPipe(DomainsBrandParamDto)) _params: DomainsBrandParamDto,
  ): Promise<CustomDomainList> {
    return this.#domains.list(getTx());
  }

  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(DomainDto)
  add(
    @Param(new ZodValidationPipe(DomainsBrandParamDto)) _params: DomainsBrandParamDto,
    @Body(new ZodValidationPipe(DomainCreateRequestDto)) body: DomainCreateRequestDto,
  ): Promise<CustomDomain> {
    return this.#domains.add(requireTicketingContext(), body);
  }

  /** "Check now": queues a check and answers with the domain as it stands. */
  @Post(':domainId/check')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodSerializerDto(DomainDto)
  check(
    @Param(new ZodValidationPipe(DomainParamDto)) { domainId }: DomainParamDto,
  ): Promise<CustomDomain> {
    return this.#domains.check(requireTicketingContext(), domainId);
  }

  /** The Cloudflare flag and "Make primary". */
  @Patch(':domainId')
  @Requires('brand:manage')
  @ZodSerializerDto(DomainDto)
  update(
    @Param(new ZodValidationPipe(DomainParamDto)) { domainId }: DomainParamDto,
    @Body(new ZodValidationPipe(customDomainUpdateRequestSchema))
    body: CustomDomainUpdateRequest,
  ): Promise<CustomDomain> {
    return this.#domains.update(requireTicketingContext(), domainId, body);
  }

  @Delete(':domainId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(DomainParamDto)) { domainId }: DomainParamDto,
  ): Promise<void> {
    await this.#domains.remove(requireTicketingContext(), domainId);
  }
}
