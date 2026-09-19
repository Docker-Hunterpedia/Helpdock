import type { Account, AccountDetail, AccountList } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { AccountsService } from './accounts.service.js';
import { contactContext } from './contact-context.js';
import {
  AccountCreateRequestDto,
  AccountDetailDto,
  AccountDto,
  AccountIdParamDto,
  AccountListDto,
  AccountSearchQueryDto,
  AccountUpdateRequestDto,
} from './dto.js';

/**
 * The customer companies of one brand. The same permissions as contacts, for
 * the same reason: an account is a fact about the people a brand supports, and
 * whoever may correct one may correct the other.
 *
 * There is no delete. An account with contacts filed under it is history, and
 * `contacts.account_id` becoming null on a whim would silently unfile them; the
 * retention rules of DOMAIN-RULES §11 are what remove customer data.
 */
@Controller('api/brands/:brandId/accounts')
export class AccountsController {
  readonly #accounts: AccountsService;

  constructor(@Inject(AccountsService) accounts: AccountsService) {
    this.#accounts = accounts;
  }

  @Get()
  @Requires('contact:read')
  @ZodSerializerDto(AccountListDto)
  list(
    @Query(new ZodValidationPipe(AccountSearchQueryDto)) query: AccountSearchQueryDto,
  ): Promise<AccountList> {
    return this.#accounts.list(contactContext(), query);
  }

  @Post()
  @Requires('contact:write')
  @ZodSerializerDto(AccountDto)
  create(
    @Body(new ZodValidationPipe(AccountCreateRequestDto)) body: AccountCreateRequestDto,
  ): Promise<Account> {
    return this.#accounts.create(contactContext(), body);
  }

  @Get(':accountId')
  @Requires('contact:read')
  @ZodSerializerDto(AccountDetailDto)
  detail(
    @Param(new ZodValidationPipe(AccountIdParamDto)) { accountId }: AccountIdParamDto,
  ): Promise<AccountDetail> {
    return this.#accounts.detail(contactContext(), accountId);
  }

  @Patch(':accountId')
  @Requires('contact:write')
  @ZodSerializerDto(AccountDto)
  update(
    @Param(new ZodValidationPipe(AccountIdParamDto)) { accountId }: AccountIdParamDto,
    @Body(new ZodValidationPipe(AccountUpdateRequestDto)) body: AccountUpdateRequestDto,
  ): Promise<Account> {
    return this.#accounts.update(contactContext(), accountId, body);
  }
}
