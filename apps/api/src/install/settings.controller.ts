import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
  SmtpSettings,
  SmtpSettingsTestRequest,
  SmtpSettingsUpdate,
  SmtpTestResult,
} from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { SmtpTestResultDto } from './dto.js';
import {
  InstallAuthenticationSettingsDto,
  InstallAuthenticationSettingsUpdateDto,
  SmtpSettingsDto,
  SmtpSettingsTestRequestDto,
  SmtpSettingsUpdateDto,
} from './settings.dto.js';
import { InstallSettingsService } from './settings.service.js';
import { SmtpSettingsService } from './smtp-settings.service.js';

@Controller('api/install/settings')
export class InstallSettingsController {
  readonly #settings: InstallSettingsService;
  readonly #smtp: SmtpSettingsService;

  constructor(
    @Inject(InstallSettingsService) settings: InstallSettingsService,
    @Inject(SmtpSettingsService) smtp: SmtpSettingsService,
  ) {
    this.#settings = settings;
    this.#smtp = smtp;
  }

  @Get('authentication')
  @Requires('install:admin')
  @ZodSerializerDto(InstallAuthenticationSettingsDto)
  authentication(): Promise<InstallAuthenticationSettings> {
    return this.#settings.authentication();
  }

  @Put('authentication')
  @Requires('install:admin')
  @ZodSerializerDto(InstallAuthenticationSettingsDto)
  saveAuthentication(
    @Body(new ZodValidationPipe(InstallAuthenticationSettingsUpdateDto))
    body: InstallAuthenticationSettingsUpdate,
  ): Promise<InstallAuthenticationSettings> {
    return this.#settings.saveAuthentication(body);
  }

  /** The install's system sender: what the Outgoing email card draws (#369). */
  @Get('smtp')
  @Requires('install:admin')
  @ZodSerializerDto(SmtpSettingsDto)
  smtp(): Promise<SmtpSettings> {
    return this.#smtp.read();
  }

  @Put('smtp')
  @Requires('install:admin')
  @ZodSerializerDto(SmtpSettingsDto)
  saveSmtp(
    @Body(new ZodValidationPipe(SmtpSettingsUpdateDto)) body: SmtpSettingsUpdate,
  ): Promise<SmtpSettings> {
    return this.#smtp.save(body);
  }

  /**
   * "Send a test email" with the credentials on screen. One transport per
   * attempt, the answer drawn inline; the wizard step's test, signed in.
   */
  @Post('smtp/test')
  @Requires('install:admin')
  @ZodSerializerDto(SmtpTestResultDto)
  testSmtp(
    @Body(new ZodValidationPipe(SmtpSettingsTestRequestDto)) body: SmtpSettingsTestRequest,
    @Req() request: FastifyRequest,
  ): Promise<SmtpTestResult> {
    return this.#smtp.test(body, request.ip);
  }
}
