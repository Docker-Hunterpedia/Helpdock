import type { CsatSurveyView } from '@helpdock/schemas';
import { csatSurveyViewSchema } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { CsatService } from './csat.service.js';
import { CsatSubmitRequestDto, CsatTokenParamDto } from './dto.js';

/**
 * The rating page's two calls (M1-12, DOMAIN-RULES §4.6). `@Public()`: the
 * token in the path is the credential, as an invitation's is, and the person
 * holding it has no session. `csat.service.ts` says how the brand is reached
 * without one.
 *
 * Both handlers replace the token in the request path before the request line
 * is logged, so a log is never a list of working links.
 *
 * The answer is parsed by hand rather than through `@ZodSerializerDto`,
 * because {@link csatSurveyViewSchema} is a discriminated union and
 * `createZodDto` cannot wrap one — `InvitesController` does the same for the
 * sign-in response.
 */
@Controller('api/public/csat')
export class CsatController {
  readonly #csat: CsatService;

  constructor(@Inject(CsatService) csat: CsatService) {
    this.#csat = csat;
  }

  @Get(':token')
  @Public()
  async view(
    @Param(new ZodValidationPipe(CsatTokenParamDto)) { token }: CsatTokenParamDto,
    @Req() request: FastifyRequest,
  ): Promise<CsatSurveyView> {
    requireRequestContext().path = '/api/public/csat/:token';

    return csatSurveyViewSchema.parse(await this.#csat.view(token, request.ip));
  }

  @Post(':token')
  @Public()
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param(new ZodValidationPipe(CsatTokenParamDto)) { token }: CsatTokenParamDto,
    @Body(new ZodValidationPipe(CsatSubmitRequestDto)) body: CsatSubmitRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<CsatSurveyView> {
    requireRequestContext().path = '/api/public/csat/:token';

    return csatSurveyViewSchema.parse(await this.#csat.submit(token, request.ip, body));
  }
}
