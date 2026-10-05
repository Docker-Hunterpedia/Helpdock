import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { isUuid } from '@helpdock/db';

/**
 * Everything one brand keeps in the bucket, as a whole: how big it is (the
 * System page's storage usage, M8-05) and removing it (the brand purge,
 * M8-07).
 *
 * It rests on one rule the key layout already keeps: **every object a brand
 * owns is under `brands/<brand id>/`** — ticket attachments and their variants
 * (`media/keys.ts`) and the help center's article images, logo and favicon
 * (`hc_media`, `help-center/media.service.ts`). A prefix is therefore the brand,
 * and nothing outside it is.
 */

export interface PrefixUsage {
  readonly bytes: number;
  readonly objects: number;
}

export interface BrandObjects {
  usage(brandId: string): Promise<PrefixUsage>;
  /** Deletes every object under the brand's prefix and says how many it removed. */
  removeAll(brandId: string): Promise<number>;
}

/** The brand's prefix. A brand id that is not a UUID could widen it, so it is refused. */
export const brandPrefix = (brandId: string): string => {
  if (!isUuid(brandId)) {
    throw new TypeError('A brand prefix needs a UUID brand id');
  }
  return `brands/${brandId.toLowerCase()}/`;
};

/** S3 lists and deletes at most a thousand keys per call. */
const PAGE = 1_000;

export class S3BrandObjects implements BrandObjects {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async usage(brandId: string): Promise<PrefixUsage> {
    let bytes = 0;
    let objects = 0;
    for await (const page of this.#pages(brandPrefix(brandId))) {
      for (const object of page) {
        bytes += object.size;
        objects += 1;
      }
    }

    return { bytes, objects };
  }

  /**
   * Page by page: list a thousand, delete them, list again. Each page is
   * deleted before the next is asked for, so the listing never has to hold
   * the whole prefix, and a crash halfway leaves fewer objects for the retry.
   */
  async removeAll(brandId: string): Promise<number> {
    const prefix = brandPrefix(brandId);
    let removed = 0;
    for (;;) {
      const page = await this.#list(prefix, undefined);
      if (page.keys.length === 0) {
        return removed;
      }
      await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: page.keys.map((object) => ({ Key: object.key })), Quiet: true },
        }),
      );
      removed += page.keys.length;
    }
  }

  async *#pages(prefix: string): AsyncGenerator<readonly { key: string; size: number }[]> {
    let token: string | undefined;
    do {
      const page = await this.#list(prefix, token);
      yield page.keys;
      token = page.next;
    } while (token !== undefined);
  }

  async #list(
    prefix: string,
    token: string | undefined,
  ): Promise<{ keys: { key: string; size: number }[]; next: string | undefined }> {
    const response = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: prefix,
        MaxKeys: PAGE,
        ...(token === undefined ? {} : { ContinuationToken: token }),
      }),
    );
    const keys = (response.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ key: object.Key, size: object.Size ?? 0 }],
    );

    return {
      keys,
      next: response.IsTruncated === true ? response.NextContinuationToken : undefined,
    };
  }
}
