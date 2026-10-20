import type {
  Passkey,
  PasskeyAdded,
  PasskeyList,
  PasskeyRegistrationOptions,
  PasskeyStepUpOptions,
  RecoveryCodes,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { getTx, requireRequestContext } from '../../context/request-context.js';
import { RecoveryCodesDto } from '../dto.js';
import { requireStaffPrincipalId } from '../principal.js';
import { Authenticated } from '../route-declaration.js';
import {
  PasskeyAddedDto,
  PasskeyBeginRequestDto,
  PasskeyDto,
  PasskeyFinishRequestDto,
  PasskeyIdParamDto,
  PasskeyListDto,
  PasskeyRecoveryRedrawRequestDto,
  PasskeyRegistrationOptionsDto,
  PasskeyRemoveRequestDto,
  PasskeyRenameRequestDto,
  PasskeyStepUpOptionsDto,
} from './dto.js';
import { PasskeyService } from './passkey.service.js';

/**
 * A person's own passkeys, on `/me/security` (M18-02). Every route is
 * `@Authenticated()` and none names a user: the account acted on is the one
 * making the request, and a passkey id that is not theirs is a 404 like one
 * that does not exist.
 *
 * Adding, renaming and removing each carry a `proof` (the password, a live
 * code or a passkey assertion) in the body; the session alone is not enough.
 */
@Controller('api/me/passkeys')
export class PasskeysController {
  readonly #passkeys: PasskeyService;

  constructor(@Inject(PasskeyService) passkeys: PasskeyService) {
    this.#passkeys = passkeys;
  }

  @Get()
  @Authenticated()
  @ZodSerializerDto(PasskeyListDto)
  list(): Promise<PasskeyList> {
    return this.#passkeys.list(this.#userId(), getTx());
  }

  /** Options for answering "confirm it's you" with a passkey the account holds. */
  @Post('step-up/options')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(PasskeyStepUpOptionsDto)
  async stepUpOptions(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<PasskeyStepUpOptions> {
    return this.#passkeys.stepUpOptions(await this.#session(authorization));
  }

  @Post('begin')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(PasskeyRegistrationOptionsDto)
  async begin(
    @Body(new ZodValidationPipe(PasskeyBeginRequestDto)) body: PasskeyBeginRequestDto,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<PasskeyRegistrationOptions> {
    return this.#passkeys.beginRegistration(await this.#session(authorization), body.proof);
  }

  @Post('finish')
  @Authenticated()
  @ZodSerializerDto(PasskeyAddedDto)
  async finish(
    @Body(new ZodValidationPipe(PasskeyFinishRequestDto)) body: PasskeyFinishRequestDto,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<PasskeyAdded> {
    return this.#passkeys.finishRegistration(await this.#session(authorization), body);
  }

  /** Ten new recovery codes, behind an assertion from a passkey the account holds. */
  @Post('recovery-codes')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RecoveryCodesDto)
  async regenerateRecoveryCodes(
    @Body(new ZodValidationPipe(PasskeyRecoveryRedrawRequestDto))
    body: PasskeyRecoveryRedrawRequestDto,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<RecoveryCodes> {
    return this.#passkeys.regenerateRecoveryCodes(await this.#session(authorization), body);
  }

  @Patch(':id')
  @Authenticated()
  @ZodSerializerDto(PasskeyDto)
  async rename(
    @Param(new ZodValidationPipe(PasskeyIdParamDto)) { id }: PasskeyIdParamDto,
    @Body(new ZodValidationPipe(PasskeyRenameRequestDto)) body: PasskeyRenameRequestDto,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<Passkey> {
    return this.#passkeys.rename(await this.#session(authorization), id, body.name, body.proof);
  }

  @Delete(':id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(PasskeyIdParamDto)) { id }: PasskeyIdParamDto,
    @Body(new ZodValidationPipe(PasskeyRemoveRequestDto)) body: PasskeyRemoveRequestDto,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    await this.#passkeys.remove(await this.#session(authorization), id, body.proof);
  }

  /** The guard has already refused anything but a staff principal with a live session. */
  #userId(): string {
    return requireStaffPrincipalId(requireRequestContext().principal);
  }

  #session(authorization: string | undefined) {
    return this.#passkeys.sessionOf(this.#userId(), authorization, getTx());
  }
}
