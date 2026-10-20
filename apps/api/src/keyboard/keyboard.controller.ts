import { type KeyboardPreferences, keyboardPreferencesSchema } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, NotFoundException, Put } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Authenticated } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { KeyboardRepository } from './keyboard.repository.js';

/**
 * Declared here rather than in `@helpdock/schemas` for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`.
 */
class KeyboardPreferencesDto extends createZodDto(keyboardPreferencesSchema) {}

const userId = (): string => requireStaffPrincipalId(requireRequestContext().principal);

/**
 * M14-01: the single-key shortcuts switch, in the `?` sheet's footer. Like
 * every `/api/me` route it names no user: the setting is the caller's own,
 * and it is the same in every brand they work in.
 */
@Controller('api/me/keyboard')
export class KeyboardController {
  readonly #repository: KeyboardRepository;

  constructor(@Inject(KeyboardRepository) repository: KeyboardRepository) {
    this.#repository = repository;
  }

  @Get()
  @Authenticated()
  @ZodSerializerDto(KeyboardPreferencesDto)
  async preferences(): Promise<KeyboardPreferences> {
    const found = await this.#repository.read(getTx(), userId());
    /* c8 ignore next 3 -- a signed-in caller's own row always exists. */
    if (found === undefined) {
      throw new NotFoundException();
    }
    return found;
  }

  @Put()
  @Authenticated()
  @ZodSerializerDto(KeyboardPreferencesDto)
  async save(
    @Body(new ZodValidationPipe(KeyboardPreferencesDto)) body: KeyboardPreferencesDto,
  ): Promise<KeyboardPreferences> {
    await this.#repository.save(getTx(), userId(), body);
    return this.preferences();
  }
}
