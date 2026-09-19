import type { Me } from '@helpdock/schemas';
import { Controller, Get } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Authenticated } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { MeDto } from './dto.js';

/**
 * Who am I? The answer is the principal itself, so there is no permission to
 * check beyond having one: `@Authenticated()` rather than `@Requires(...)`.
 *
 * It exists to prove the plumbing — the resolver ran, the guard accepted, the
 * context carries what it resolved — and `apps/admin` uses it on load to learn
 * its brands and role.
 */
@Controller('api')
export class MeController {
  @Get('me')
  @Authenticated()
  @ZodSerializerDto(MeDto)
  me(): Me {
    const principal = requireRequestContext().principal;
    /* c8 ignore next 3 -- the guard refuses the request before this can happen. */
    if (principal === null) {
      throw new Error('The authentication guard let an unauthenticated request through');
    }

    return { principal };
  }
}
