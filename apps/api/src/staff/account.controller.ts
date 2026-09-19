import type { Profile, RecoveryCodes, StaffSessionList } from '@helpdock/schemas';
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
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Authenticated } from '../auth/route-declaration.js';
import { decodeRefreshCookie, REFRESH_COOKIE } from '../auth/session/cookies.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { AccountService } from './account.service.js';
import {
  PasswordChangeRequestDto,
  ProfileDto,
  ProfileUpdateRequestDto,
  RecoveryCodesDto,
  SessionFamilyParamDto,
  StaffSessionListDto,
  TotpCodeRequestDto,
} from './dto.js';

/**
 * A person's own account: their details, their password, their second factor
 * and the browsers they are signed in on. The screen is `/me/security`.
 *
 * Every route is `@Authenticated()` and none takes a user id: the account acted
 * on is always the one making the request. There is nothing to authorise beyond
 * holding a session, and no parameter that could name somebody else.
 *
 * The three routes that weaken a credential — changing a password, turning the
 * second factor off, redrawing the recovery codes — each ask for a credential
 * of their own. A session is proof that somebody signed in, not that the person
 * at the keyboard now is the account holder.
 */
@Controller('api/me')
export class AccountController {
  readonly #account: AccountService;

  constructor(@Inject(AccountService) account: AccountService) {
    this.#account = account;
  }

  @Get('profile')
  @Authenticated()
  @ZodSerializerDto(ProfileDto)
  profile(): Promise<Profile> {
    return this.#account.profile(getTx(), this.#userId());
  }

  @Patch('profile')
  @Authenticated()
  @ZodSerializerDto(ProfileDto)
  updateProfile(
    @Body(new ZodValidationPipe(ProfileUpdateRequestDto)) body: ProfileUpdateRequestDto,
  ): Promise<Profile> {
    return this.#account.updateProfile(getTx(), this.#userId(), body);
  }

  @Post('password')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body(new ZodValidationPipe(PasswordChangeRequestDto)) body: PasswordChangeRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.#account.changePassword({
      tx: getTx(),
      userId: this.#userId(),
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepFamilyId: this.#familyId(request),
    });
  }

  @Post('totp/disable')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableTotp(
    @Body(new ZodValidationPipe(TotpCodeRequestDto)) body: TotpCodeRequestDto,
  ): Promise<void> {
    await this.#account.disableTotp(getTx(), this.#userId(), body.code);
  }

  @Post('recovery-codes/regenerate')
  @Authenticated()
  @ZodSerializerDto(RecoveryCodesDto)
  regenerateRecoveryCodes(
    @Body(new ZodValidationPipe(TotpCodeRequestDto)) body: TotpCodeRequestDto,
  ): Promise<RecoveryCodes> {
    return this.#account.regenerateRecoveryCodes(getTx(), this.#userId(), body.code);
  }

  @Get('sessions')
  @Authenticated()
  @ZodSerializerDto(StaffSessionListDto)
  sessions(@Req() request: FastifyRequest): Promise<StaffSessionList> {
    return this.#account.sessions(this.#userId(), this.#familyId(request));
  }

  /**
   * Ending the browser this request came from is allowed: the family is
   * revoked, the next refresh fails, and the app lands on sign-in. The cookie
   * is left for `POST /api/auth/sign-out` to clear, which is the route that
   * owns it.
   */
  @Delete('sessions/:family')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @Param(new ZodValidationPipe(SessionFamilyParamDto)) { family }: SessionFamilyParamDto,
  ): Promise<void> {
    await this.#account.revokeSession(this.#userId(), family);
  }

  // ------------------------------------------------------------------

  /** The guard has already refused anything but a staff principal with a session. */
  #userId(): string {
    return requireStaffPrincipalId(requireRequestContext().principal);
  }

  /** This browser's own refresh family, so the list can mark it and a password change can spare it. */
  #familyId(request: FastifyRequest): string | null {
    return decodeRefreshCookie(request.cookies[REFRESH_COOKIE])?.fam ?? null;
  }
}
