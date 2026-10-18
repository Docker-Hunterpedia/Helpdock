import type { Db } from '@helpdock/db';
import { hcImportAssetParamSchema, importUrlSchema } from '@helpdock/schemas';
import { Controller, Get, Header, HttpStatus, Inject, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { DB } from '../runtime/tokens.js';
import { HelpCenterImportAssetsService } from './import-assets.service.js';
import { STAFF_COOKIE } from './site/staff-access.js';

class ImportAssetParams extends createZodDto(hcImportAssetParamSchema) {}

/** Public delivery follows article readership; signed staff previews use the existing live help-center cookie. */
@Controller()
export class HelpCenterImportAssetsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(HelpCenterImportAssetsService) private readonly assets: HelpCenterImportAssetsService,
  ) {}

  @Get('api/help-center/brands/:brandId/assets/:assetId')
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async redirect(
    @Param(new ZodValidationPipe(ImportAssetParams)) params: ImportAssetParams,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const url = importUrlSchema.parse(
      await this.assets.redirect(this.db, params, request.cookies?.[STAFF_COOKIE]),
    );
    await reply.redirect(url, HttpStatus.FOUND);
  }

  @Get('hc/:brandId/_hd/assets/:assetId')
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async fallback(
    @Param(new ZodValidationPipe(ImportAssetParams)) params: ImportAssetParams,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.redirect(params, request, reply);
  }
}
