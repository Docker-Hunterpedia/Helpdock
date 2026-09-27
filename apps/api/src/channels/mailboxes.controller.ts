import {
  type ImapTestRequest,
  type ImapTestResult,
  type InboundParseSecret,
  type InboundParseSettings,
  imapTestRequestSchema,
  imapTestResultSchema,
  type Mailbox,
  type MailboxCreateRequest,
  type MailboxList,
  type MailboxUpdateRequest,
  mailboxCreateRequestSchema,
  mailboxUpdateRequestSchema,
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
  ChannelsBrandParamDto,
  InboundParseSecretDto,
  InboundParseSettingsDto,
  MailboxDto,
  MailboxListDto,
  MailboxParamDto,
} from './dto.js';
import { MailboxesService } from './mailboxes.service.js';

/**
 * Channels › Mailboxes (M2-08): the mailbox list, the mailbox form and its
 * Test IMAP button, and the inbound-parse card's shared secret.
 *
 * **`brand:manage` throughout**, reading included. REQUIREMENTS §4.10 puts
 * channels with brands and domains, which are the Admin's; a mailbox carries a
 * server, a login and where a brand's mail lands, and a Team Leader's
 * "departments they lead" (DOMAIN-RULES §1.2) does not reach any of that.
 */
@Controller('api/brands/:brandId')
export class MailboxesController {
  readonly #mailboxes: MailboxesService;

  constructor(@Inject(MailboxesService) mailboxes: MailboxesService) {
    this.#mailboxes = mailboxes;
  }

  @Get('mailboxes')
  @Requires('brand:manage')
  @ZodSerializerDto(MailboxListDto)
  list(
    @Param(new ZodValidationPipe(ChannelsBrandParamDto)) _params: ChannelsBrandParamDto,
  ): Promise<MailboxList> {
    return this.#mailboxes.list(getTx());
  }

  @Post('mailboxes')
  @Requires('brand:manage')
  @ZodSerializerDto(MailboxDto)
  create(
    @Param(new ZodValidationPipe(ChannelsBrandParamDto)) _params: ChannelsBrandParamDto,
    @Body(new ZodValidationPipe(mailboxCreateRequestSchema)) body: MailboxCreateRequest,
  ): Promise<Mailbox> {
    return this.#mailboxes.create(requireTicketingContext(), body);
  }

  @Get('mailboxes/:mailboxId')
  @Requires('brand:manage')
  @ZodSerializerDto(MailboxDto)
  get(
    @Param(new ZodValidationPipe(MailboxParamDto)) { mailboxId }: MailboxParamDto,
  ): Promise<Mailbox> {
    return this.#mailboxes.get(getTx(), mailboxId);
  }

  /** "Save mailbox": the whole form, so it is a `PUT`. */
  @Put('mailboxes/:mailboxId')
  @Requires('brand:manage')
  @ZodSerializerDto(MailboxDto)
  update(
    @Param(new ZodValidationPipe(MailboxParamDto)) { mailboxId }: MailboxParamDto,
    @Body(new ZodValidationPipe(mailboxUpdateRequestSchema)) body: MailboxUpdateRequest,
  ): Promise<Mailbox> {
    return this.#mailboxes.update(requireTicketingContext(), mailboxId, body);
  }

  @Delete('mailboxes/:mailboxId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(MailboxParamDto)) { mailboxId }: MailboxParamDto,
  ): Promise<void> {
    await this.#mailboxes.remove(requireTicketingContext(), mailboxId);
  }

  /** A `POST` although it changes nothing: it carries a password, which a query string must never hold. */
  @Post('mailboxes/test-imap')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  async testImap(
    @Param(new ZodValidationPipe(ChannelsBrandParamDto)) _params: ChannelsBrandParamDto,
    @Body(new ZodValidationPipe(imapTestRequestSchema)) body: ImapTestRequest,
  ): Promise<ImapTestResult> {
    return imapTestResultSchema.parse(await this.#mailboxes.testImap(getTx(), body));
  }

  @Get('inbound-parse')
  @Requires('brand:manage')
  @ZodSerializerDto(InboundParseSettingsDto)
  parseSettings(
    @Param(new ZodValidationPipe(ChannelsBrandParamDto)) { brandId }: ChannelsBrandParamDto,
  ): Promise<InboundParseSettings> {
    return this.#mailboxes.parseSettings(getTx(), brandId);
  }

  @Post('inbound-parse/secret')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(InboundParseSecretDto)
  replaceSecret(
    @Param(new ZodValidationPipe(ChannelsBrandParamDto)) _params: ChannelsBrandParamDto,
  ): Promise<InboundParseSecret> {
    return this.#mailboxes.replaceSecret(requireTicketingContext());
  }
}
