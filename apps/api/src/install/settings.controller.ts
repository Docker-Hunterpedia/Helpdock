import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
} from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import {
  InstallAuthenticationSettingsDto,
  InstallAuthenticationSettingsUpdateDto,
} from './settings.dto.js';
import { InstallSettingsService } from './settings.service.js';

@Controller('api/install/settings')
export class InstallSettingsController {
  readonly #settings: InstallSettingsService;

  constructor(@Inject(InstallSettingsService) settings: InstallSettingsService) {
    this.#settings = settings;
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
}
