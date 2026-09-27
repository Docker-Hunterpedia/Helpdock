import { remoteImageParamSchema } from '@helpdock/schemas';
import { Controller, Get, Header, Inject, Param, StreamableFile } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { z } from 'zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { RemoteImagesService } from './remote-images.service.js';

/**
 * "Load images" and the proxy mode of M2-07: one remote image of one email,
 * fetched by the server and re-encoded. `ticket:read`, because it is part of
 * reading the thread, and the message is read under the request's own scope.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/messages/:messageId/remote-images')
export class RemoteImagesController {
  readonly #images: RemoteImagesService;

  constructor(@Inject(RemoteImagesService) images: RemoteImagesService) {
    this.#images = images;
  }

  @Get(':index')
  @Requires('ticket:read')
  // Private: it is somebody's mail. Five minutes, like a presigned download.
  @Header('cache-control', 'private, max-age=300')
  @Header('content-disposition', 'inline')
  async load(
    @Param(new ZodValidationPipe(remoteImageParamSchema))
    { ticketId, messageId, index }: z.infer<typeof remoteImageParamSchema>,
  ): Promise<StreamableFile> {
    const image = await this.#images.load(getTx(), { ticketId, messageId, index });

    return new StreamableFile(image.body, { type: image.contentType, length: image.body.length });
  }
}
