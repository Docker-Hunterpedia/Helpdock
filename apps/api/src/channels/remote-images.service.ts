import { type DbTransaction, ticketMessages } from '@helpdock/db';
import { policies, SafeFetchError, type SafeFetchPolicy, safeFetch } from '@helpdock/net';
import { emailMessageMetaSchema } from '@helpdock/schemas';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';

/**
 * The remote-image proxy of M2-07 (REQUIREMENTS §5.1: "remote images proxied/
 * blocked (toggle)").
 *
 * An agent's browser never fetches a sender's image. The api does, and only:
 *
 * - **for a message the agent may read.** The message is read in the request's
 *   transaction, so a ticket in another department is not found, exactly as
 *   the thread itself is not (DOMAIN-RULES §1.3). The URL is taken from the
 *   stored message by index; the client never names one, so the endpoint is
 *   not an open proxy.
 * - **through the SSRF-safe client** (DOMAIN-RULES §13): public addresses only,
 *   every redirect re-checked, 20 MB and 30 s at most, `OUTBOUND_ALLOW_CIDRS`
 *   honoured.
 * - **re-encoded.** Whatever came back is decoded by sharp and written out as
 *   WebP, capped at 2048 px, with its metadata stripped — the same treatment
 *   an uploaded image gets (ARCHITECTURE §9) — so a polyglot or a script
 *   dressed as an SVG never reaches the admin's origin.
 */

export const MAX_PROXIED_IMAGE_EDGE = 2048;
/** Refuses decompression bombs before sharp allocates for them. */
const MAX_INPUT_PIXELS = 40_000_000;

export interface ProxiedImage {
  readonly body: Buffer;
  readonly contentType: 'image/webp';
}

export interface RemoteImageFetcher {
  fetch(url: string): Promise<{ status: number; contentType: string; body: Buffer }>;
}

export const safeImageFetcher = (options: {
  readonly allowCidrs: readonly string[];
  readonly onBlocked?: SafeFetchPolicy['onBlocked'];
  readonly lookup?: SafeFetchPolicy['lookup'];
}): RemoteImageFetcher => ({
  fetch: async (url) => {
    const response = await safeFetch(
      url,
      { headers: { accept: 'image/*', 'user-agent': 'Helpdock image proxy' } },
      {
        ...policies.imageProxy,
        allowCidrs: [...options.allowCidrs],
        ...(options.onBlocked === undefined ? {} : { onBlocked: options.onBlocked }),
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      },
    );
    const contentType = response.headers['content-type'];

    return {
      status: response.status,
      contentType: (Array.isArray(contentType) ? contentType[0] : contentType) ?? '',
      body: response.body,
    };
  },
});

export class RemoteImagesService {
  readonly #fetcher: RemoteImageFetcher;

  constructor(fetcher: RemoteImageFetcher) {
    this.#fetcher = fetcher;
  }

  async load(
    tx: DbTransaction,
    input: { readonly ticketId: string; readonly messageId: string; readonly index: number },
  ): Promise<ProxiedImage> {
    const rows = await tx
      .select({ email: ticketMessages.email })
      .from(ticketMessages)
      .where(
        and(eq(ticketMessages.id, input.messageId), eq(ticketMessages.ticketId, input.ticketId)),
      )
      .limit(1);
    const meta = emailMessageMetaSchema.safeParse(rows[0]?.email);
    const image = meta.success ? meta.data.remoteImages[input.index] : undefined;
    if (image === undefined) {
      throw new NotFoundException('No such image on this message');
    }

    let fetched: Awaited<ReturnType<RemoteImageFetcher['fetch']>>;
    try {
      fetched = await this.#fetcher.fetch(image.url);
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw new UnprocessableEntityException('That image could not be fetched');
      }
      throw error;
    }
    if (fetched.status < 200 || fetched.status >= 300 || !/^image\//i.test(fetched.contentType)) {
      throw new UnprocessableEntityException('That address did not answer with an image');
    }

    try {
      const body = await sharp(fetched.body, {
        limitInputPixels: MAX_INPUT_PIXELS,
        animated: false,
      })
        .rotate()
        .resize({
          width: MAX_PROXIED_IMAGE_EDGE,
          height: MAX_PROXIED_IMAGE_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();

      return { body, contentType: 'image/webp' };
    } catch {
      throw new UnprocessableEntityException('That image could not be decoded');
    }
  }
}
