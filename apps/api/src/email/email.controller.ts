import type {
  EmailOutgoingSettings,
  EmailSignature,
  FailedSendList,
  FailedSendRetryResult,
  OutgoingSmtpTestResult,
  TicketEmailContext,
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
import { Authenticated, Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  AutoRepliesDto,
  EmailBrandParamDto,
  EmailOutgoingSettingsDto,
  EmailSendersDto,
  EmailSignatureDto,
  FailedSendListDto,
  FailedSendParamDto,
  FailedSendRetryResultDto,
  OutgoingSmtpTestResultDto,
  OutgoingSmtpUpdateDto,
  TicketEmailContextDto,
  TicketEmailParamDto,
  TicketMessageDeliveryParamDto,
} from './dto.js';
import { type EmailSettingsContext, EmailSettingsService } from './email-settings.service.js';

const actorId = (): string => requireStaffPrincipalId(requireRequestContext().principal);

const context = (brandId: string): EmailSettingsContext => ({
  tx: getTx(),
  brandId,
  actorId: actorId(),
});

/**
 * Channels › Outgoing email (artboard `AdminEmailOutgoing`, M2-05, M2-06,
 * M2-08's outbound half). Every route is `brand:manage`: a brand's mail server
 * and what it says to customers on its own are brand-wide configuration, which
 * DOMAIN-RULES §1.2 keeps with the Admin.
 */
@Controller('api/brands/:brandId/email')
export class EmailSettingsController {
  readonly #email: EmailSettingsService;

  constructor(@Inject(EmailSettingsService) email: EmailSettingsService) {
    this.#email = email;
  }

  @Get('outgoing')
  @Requires('brand:manage')
  @ZodSerializerDto(EmailOutgoingSettingsDto)
  outgoing(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) { brandId }: EmailBrandParamDto,
  ): Promise<EmailOutgoingSettings> {
    return this.#email.outgoing(getTx(), brandId);
  }

  @Put('outgoing/smtp')
  @Requires('brand:manage')
  @ZodSerializerDto(EmailOutgoingSettingsDto)
  saveSmtp(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) { brandId }: EmailBrandParamDto,
    @Body(new ZodValidationPipe(OutgoingSmtpUpdateDto)) body: OutgoingSmtpUpdateDto,
  ): Promise<EmailOutgoingSettings> {
    return this.#email.saveSmtp(context(brandId), body);
  }

  @Post('outgoing/smtp/test')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(OutgoingSmtpTestResultDto)
  testSmtp(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) { brandId }: EmailBrandParamDto,
    @Body(new ZodValidationPipe(OutgoingSmtpUpdateDto)) body: OutgoingSmtpUpdateDto,
  ): Promise<OutgoingSmtpTestResult> {
    return this.#email.testSmtp(context(brandId), body);
  }

  @Put('outgoing/senders')
  @Requires('brand:manage')
  @ZodSerializerDto(EmailOutgoingSettingsDto)
  saveSenders(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) { brandId }: EmailBrandParamDto,
    @Body(new ZodValidationPipe(EmailSendersDto)) body: EmailSendersDto,
  ): Promise<EmailOutgoingSettings> {
    return this.#email.saveSenders(context(brandId), body);
  }

  @Put('outgoing/auto-replies')
  @Requires('brand:manage')
  @ZodSerializerDto(EmailOutgoingSettingsDto)
  saveAutoReplies(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) { brandId }: EmailBrandParamDto,
    @Body(new ZodValidationPipe(AutoRepliesDto)) body: AutoRepliesDto,
  ): Promise<EmailOutgoingSettings> {
    return this.#email.saveAutoReplies(context(brandId), body);
  }

  @Get('failed-sends')
  @Requires('brand:manage')
  @ZodSerializerDto(FailedSendListDto)
  failedSends(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) _param: EmailBrandParamDto,
  ): Promise<FailedSendList> {
    return this.#email.failedSends(getTx());
  }

  @Post('failed-sends/retry-all')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(FailedSendRetryResultDto)
  async retryAll(
    @Param(new ZodValidationPipe(EmailBrandParamDto)) { brandId }: EmailBrandParamDto,
  ): Promise<FailedSendRetryResult> {
    return { retried: await this.#email.retryAll(context(brandId)) };
  }

  @Post('failed-sends/:deliveryId/retry')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @Param(new ZodValidationPipe(FailedSendParamDto)) { brandId, deliveryId }: FailedSendParamDto,
  ): Promise<void> {
    await this.#email.retry(context(brandId), deliveryId);
  }

  @Post('failed-sends/:deliveryId/discard')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @Param(new ZodValidationPipe(FailedSendParamDto)) { brandId, deliveryId }: FailedSendParamDto,
  ): Promise<void> {
    await this.#email.discard(context(brandId), deliveryId);
  }
}

/**
 * The ticket view's email half (artboard `AdminTicketEmail`): what the
 * composer sends as and to, and the thread's "Not delivered · Retry". Reading
 * is `ticket:read`; retrying a send is working the ticket, `ticket:write`.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/email')
export class TicketEmailController {
  readonly #email: EmailSettingsService;

  constructor(@Inject(EmailSettingsService) email: EmailSettingsService) {
    this.#email = email;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TicketEmailContextDto)
  context(
    @Param(new ZodValidationPipe(TicketEmailParamDto)) { brandId, ticketId }: TicketEmailParamDto,
  ): Promise<TicketEmailContext> {
    return this.#email.ticketContext(getTx(), brandId, ticketId, actorId());
  }

  @Post('messages/:messageId/retry')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @Param(new ZodValidationPipe(TicketMessageDeliveryParamDto))
    { brandId, ticketId, messageId }: TicketMessageDeliveryParamDto,
  ): Promise<void> {
    await this.#email.retryMessage(context(brandId), ticketId, messageId);
  }
}

/**
 * Your account › Email signature (artboard `AdminSignature`). Like every
 * `/api/me` route, it names no user: the signature is the requester's own.
 */
@Controller('api/me/signature')
export class SignatureController {
  readonly #email: EmailSettingsService;

  constructor(@Inject(EmailSettingsService) email: EmailSettingsService) {
    this.#email = email;
  }

  @Get()
  @Authenticated()
  @ZodSerializerDto(EmailSignatureDto)
  signature(): Promise<EmailSignature> {
    return this.#email.signature(getTx(), actorId());
  }

  @Put()
  @Authenticated()
  @ZodSerializerDto(EmailSignatureDto)
  save(
    @Body(new ZodValidationPipe(EmailSignatureDto)) body: EmailSignatureDto,
  ): Promise<EmailSignature> {
    return this.#email.saveSignature(getTx(), actorId(), body);
  }
}
