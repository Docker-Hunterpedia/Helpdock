import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { WidgetFileParamDto } from './dto.js';
import {
  WIDGET_CHUNKS_DIR,
  WIDGET_ENTRY,
  WIDGET_FONTS_DIR,
  widgetAssetPath,
  widgetFileHeaders,
} from './widget-bundle.js';

/** The resolved widget build directory, or `undefined` when this process has none. */
export const WIDGET_DIST = Symbol('WIDGET_DIST');

/**
 * `widget.js` and what it loads (M4-01): the one script tag a customer adds,
 * `<script type="module" src="https://support.example.com/widget.js"
 * data-brand="…">`, then its lazy chunks and fonts, all from this origin.
 * Public: the file is the same for every brand, and the brand's allow-list is
 * checked by every `/api/widget` call the script makes.
 */
@Controller()
export class WidgetBundleController {
  readonly #root: string | undefined;

  constructor(@Inject(WIDGET_DIST) root: string | undefined) {
    this.#root = root;
  }

  @Get(WIDGET_ENTRY)
  @Public()
  entry(@Res() reply: FastifyReply): Promise<void> {
    return this.#send(reply, widgetAssetPath(this.#requireRoot(), null, WIDGET_ENTRY));
  }

  @Get(`${WIDGET_CHUNKS_DIR}/:file`)
  @Public()
  chunk(
    @Param(new ZodValidationPipe(WidgetFileParamDto)) { file }: WidgetFileParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.#send(reply, widgetAssetPath(this.#requireRoot(), WIDGET_CHUNKS_DIR, file));
  }

  @Get(`${WIDGET_FONTS_DIR}/:file`)
  @Public()
  font(
    @Param(new ZodValidationPipe(WidgetFileParamDto)) { file }: WidgetFileParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.#send(reply, widgetAssetPath(this.#requireRoot(), WIDGET_FONTS_DIR, file));
  }

  #requireRoot(): string {
    if (this.#root === undefined) {
      throw new NotFoundException('This process serves no widget build (WIDGET_DIST_DIR)');
    }
    return this.#root;
  }

  async #send(reply: FastifyReply, relative: string | undefined): Promise<void> {
    if (relative === undefined) {
      throw new NotFoundException('No such widget file');
    }
    await reply
      .headers(widgetFileHeaders(relative))
      .send(createReadStream(path.join(this.#requireRoot(), relative)));
  }
}
