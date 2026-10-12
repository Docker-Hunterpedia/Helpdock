import {
  type MetaAccount,
  type MetaAccountList,
  type MetaAccountStatusResponse,
  type MetaSubscribeResult,
  type MetaTestResult,
  metaSubscribeResultSchema,
  metaTestResultSchema,
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
  Post,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import {
  MetaAccountCreateDto,
  MetaAccountDto,
  MetaAccountListDto,
  MetaAccountParamDto,
  MetaAccountStatusDto,
  MetaAccountUpdateDto,
  MetaBrandParamDto,
  MetaTokenTestDto,
} from './dto.js';
import { MetaAccountsService } from './meta-accounts.service.js';

/**
 * Channels › Meta (M10-07): the account list and form, "Test connection",
 * "Subscribe now", the status panel and the token renewal.
 *
 * **`brand:manage` throughout**, reading included, as for mailboxes and
 * Telegram bots: an account carries a token and decides where a brand's
 * customers land, and DOMAIN-RULES §1.2 gives channels to the Admin. The Meta
 * app itself (`/api/meta/app`) is the install's, and `install:admin`.
 */
@Controller('api/brands/:brandId/meta/accounts')
export class MetaAccountsController {
  readonly #accounts: MetaAccountsService;

  constructor(@Inject(MetaAccountsService) accounts: MetaAccountsService) {
    this.#accounts = accounts;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(MetaAccountListDto)
  list(
    @Param(new ZodValidationPipe(MetaBrandParamDto)) _params: MetaBrandParamDto,
  ): Promise<MetaAccountList> {
    return this.#accounts.list(getTx());
  }

  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(MetaAccountDto)
  create(
    @Param(new ZodValidationPipe(MetaBrandParamDto)) _params: MetaBrandParamDto,
    @Body(new ZodValidationPipe(MetaAccountCreateDto)) body: MetaAccountCreateDto,
  ): Promise<MetaAccount> {
    return this.#accounts.create(requireTicketingContext(), body);
  }

  /** "Test" in the Connect dialog, before the account exists. Declared before `:accountId`. */
  @Post('test')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  async testToken(
    @Param(new ZodValidationPipe(MetaBrandParamDto)) _params: MetaBrandParamDto,
    @Body(new ZodValidationPipe(MetaTokenTestDto)) body: MetaTokenTestDto,
  ): Promise<MetaTestResult> {
    return metaTestResultSchema.parse(await this.#accounts.testToken(getTx(), body));
  }

  @Get(':accountId')
  @Requires('brand:manage')
  @ZodSerializerDto(MetaAccountDto)
  get(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
  ): Promise<MetaAccount> {
    return this.#accounts.get(getTx(), accountId);
  }

  /** "Save account": the whole form, so it is a `PUT`. */
  @Put(':accountId')
  @Requires('brand:manage')
  @ZodSerializerDto(MetaAccountDto)
  update(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
    @Body(new ZodValidationPipe(MetaAccountUpdateDto)) body: MetaAccountUpdateDto,
  ): Promise<MetaAccount> {
    return this.#accounts.update(requireTicketingContext(), accountId, body);
  }

  @Delete(':accountId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
  ): Promise<void> {
    await this.#accounts.remove(requireTicketingContext(), accountId);
  }

  @Post(':accountId/test')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  async test(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
  ): Promise<MetaTestResult> {
    return metaTestResultSchema.parse(await this.#accounts.test(getTx(), accountId));
  }

  @Post(':accountId/subscribe')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
  ): Promise<MetaSubscribeResult> {
    return metaSubscribeResultSchema.parse(
      await this.#accounts.subscribe(requireTicketingContext(), accountId),
    );
  }

  @Get(':accountId/status')
  @Requires('brand:manage')
  @ZodSerializerDto(MetaAccountStatusDto)
  status(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
  ): Promise<MetaAccountStatusResponse> {
    return this.#accounts.status(getTx(), accountId);
  }

  /** Renews an Instagram token that is due, and answers the account as it is after. */
  @Post(':accountId/refresh')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(MetaAccountDto)
  refresh(
    @Param(new ZodValidationPipe(MetaAccountParamDto)) { accountId }: MetaAccountParamDto,
  ): Promise<MetaAccount> {
    return this.#accounts.refresh(requireTicketingContext(), accountId);
  }
}
