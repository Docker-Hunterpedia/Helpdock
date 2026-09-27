import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import {
  FONT_CACHE_CONTROL,
  FONTS_PREFIX,
  type FontFile,
  type FontFileParam,
  fontFileParamSchema,
  loadFonts,
} from './fonts.js';

/**
 * `/_hd/fonts/*`: DESIGN §3's self-hosted fonts for the pages the api renders
 * (`fonts.ts` says why they are held in memory). `@Public()`: a font is the
 * same bytes for everybody.
 */
@Controller(FONTS_PREFIX.slice(1))
export class FontsController {
  readonly #files: ReadonlyMap<string, FontFile> = loadFonts();

  @Get(':file')
  @Public()
  async serve(
    @Param(new ZodValidationPipe(fontFileParamSchema)) { file }: FontFileParam,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const found = this.#files.get(file);
    if (found === undefined) {
      throw new NotFoundException('No such font file');
    }
    await reply
      .header('cache-control', FONT_CACHE_CONTROL)
      .type(found.contentType)
      .send(found.body);
  }
}
