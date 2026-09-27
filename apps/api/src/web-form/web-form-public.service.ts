import { randomUUID } from 'node:crypto';
import type { CaptchaRenderConfig, CaptchaTransport } from '@helpdock/channels';
import { createCaptchaProvider } from '@helpdock/channels';
import { type Db, type DbTransaction, systemContext, withTenant } from '@helpdock/db';
import { createI18n, type Locale, SUPPORTED_LNGS } from '@helpdock/i18n';
import {
  type ContentPolicy,
  customKeyOfRef,
  type WebFormFieldError,
  type WebFormFormError,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import type { BrandCaptchaKeys, CaptchaKeysReader } from '../captcha/captcha-keys.js';
import type { StorageAttachmentSink } from '../channels/inbound/attachment-sink.js';
import { isUniqueViolation } from '../channels/pg-errors.js';
import { readContentPolicy } from '../media/content-policy.js';
import { isSenderBlocked } from '../ticketing/sender-gate.js';
import { resolveFields } from './layout.js';
import {
  HONEYPOT_FIELD,
  type PageAttachments,
  type PageField,
  SUBMISSION_FIELD,
} from './page/render.js';
import {
  maxFilesFor,
  readSubmission,
  type ShownField,
  type UploadedFile,
  WEB_FORM_ATTACHMENT_KINDS,
} from './submission.js';
import type { WebFormBrand, WebFormRepository } from './web-form.repository.js';
import { defaultThankYou } from './web-form-settings.service.js';
import type { FiledTicket, WebFormTicketWriter } from './web-form-ticket.writer.js';

/**
 * The public half of M4-09: the form a stranger sees, and what happens to what
 * they send. There is no session and no principal; the brand comes from the
 * host or the path, and every read and write runs as the system principal of
 * that one brand (DOMAIN-RULES §1.4), under the job id `webform:<brandId>`.
 *
 * A submission passes, in order: the honeypot, the fields, the per-IP limit,
 * the CAPTCHA (when the brand turned it on), the per-address limit and the
 * block list — and only then writes anything. The CAPTCHA comes after the
 * fields on purpose: a token is single-use, and a customer who mistyped their
 * address should not have to solve a second challenge to fix it.
 *
 * A double submit — a second click, a refresh of the thank-you page — carries
 * the same `hd_submission` id and answers the ticket the first one filed,
 * rather than opening a second.
 */

/** Per brand and address: an office behind one address is a normal thing, so it is loose. */
export const WEB_FORM_IP_RULE: RateLimitRule = {
  bucket: 'webform-ip',
  limit: 10,
  windowSeconds: 15 * 60,
};

/** Per brand and typed email: one person writing many tickets in an hour is a loop or a flood. */
export const WEB_FORM_ADDRESS_RULE: RateLimitRule = {
  bucket: 'webform-address',
  limit: 5,
  windowSeconds: 60 * 60,
};

export interface LoadedForm {
  readonly brand: WebFormBrand;
  readonly locale: Locale;
  readonly state: 'open' | 'closed' | 'unavailable';
  readonly fields: readonly (PageField & ShownField)[];
  readonly attachments: PageAttachments | null;
  readonly captcha: CaptchaRenderConfig | null;
  readonly thankYou: string;
  readonly departmentId: string | null;
  readonly policy: ContentPolicy;
  readonly keys: BrandCaptchaKeys | null;
}

export interface WebFormPost {
  readonly fields: ReadonlyMap<string, readonly string[]>;
  readonly files: readonly UploadedFile[];
  readonly ip: string;
}

export type SubmitResult =
  | { readonly kind: 'created'; readonly reference: string }
  | {
      readonly kind: 'invalid';
      readonly errors: ReadonlyMap<string, WebFormFieldError>;
    }
  | { readonly kind: 'refused'; readonly error: WebFormFormError };

export interface WebFormPublicServiceOptions {
  readonly db: Db;
  readonly repository: WebFormRepository;
  readonly writer: WebFormTicketWriter;
  readonly captchaKeys: CaptchaKeysReader;
  readonly captchaTransport: CaptchaTransport;
  readonly limiter: RateLimiter;
  /** A fresh sink per submission, so a rolled-back one's uploads are its own to remove. */
  readonly sink: () => StorageAttachmentSink;
  readonly removeObject: (key: string) => Promise<void>;
  readonly log: { warn(fields: Record<string, unknown>, message: string): void };
}

const uuidSchema = z.uuid();

const LOCALES: readonly string[] = SUPPORTED_LNGS;

/** `?lang=` when it names a shipped locale, otherwise the brand's language (as ADR 0010). */
export const pageLocale = (requested: string | undefined, fallback: Locale): Locale =>
  requested !== undefined && LOCALES.includes(requested) ? (requested as Locale) : fallback;

const MIME_LABELS: Readonly<Record<string, string>> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'text/plain': 'TXT',
  'application/zip': 'ZIP',
};

const mimeLabel = (mime: string): string =>
  MIME_LABELS[mime] ?? (mime.split('/')[1] ?? mime).toUpperCase();

const MIB = 1024 * 1024;
/**
 * "10 MB", isolated (U+2068 … U+2069) so an Arabic sentence keeps the number
 * and its unit together and in order (DESIGN §7: numbers inside Arabic text
 * read left to right).
 */
export const megabytes = (bytes: number): string =>
  `⁨${String(Math.round((bytes / MIB) * 10) / 10)} MB⁩`;

/** The attachments control, worded for the page, or null when the brand takes no files. */
export const attachmentsFor = (policy: ContentPolicy, locale: Locale): PageAttachments | null => {
  const max = maxFilesFor(policy);
  const kinds = WEB_FORM_ATTACHMENT_KINDS.filter((kind) => policy[kind].enabled);
  if (max === 0 || kinds.length === 0) {
    return null;
  }

  const t = createI18n({ lng: locale }).getFixedT(locale, 'webform');
  const accept = kinds.flatMap((kind) => policy[kind].allowedMime);
  const labels = [...new Set(accept.map(mimeLabel))];
  const sizes =
    kinds.length === 2 && policy.image.maxBytes !== policy.file.maxBytes
      ? t('attachments.sizeBoth', {
          image: megabytes(policy.image.maxBytes),
          file: megabytes(policy.file.maxBytes),
        })
      : t('attachments.sizeOne', {
          size: megabytes(Math.max(...kinds.map((kind) => policy[kind].maxBytes))),
        });
  const list = new Intl.ListFormat(locale, { type: 'disjunction' }).format(labels);

  return {
    max,
    accept,
    hint: t('attachments.hint', {
      count: max,
      sizes,
      types: t('attachments.types', { list }),
    }),
  };
};

export class WebFormPublicService {
  readonly #options: WebFormPublicServiceOptions;

  constructor(options: WebFormPublicServiceOptions) {
    this.#options = options;
  }

  /** The form in the page's language, or null when no active brand has this id. */
  async load(brandId: string, lang: string | undefined): Promise<LoadedForm | null> {
    const keys = await this.#options.captchaKeys.forBrand(brandId);
    return this.#inBrand(brandId, (tx) => this.#read(tx, brandId, lang, keys));
  }

  async submit(form: LoadedForm, post: WebFormPost): Promise<SubmitResult> {
    const brandId = form.brand.id;
    if ((post.fields.get(HONEYPOT_FIELD)?.[0] ?? '') !== '') {
      return { kind: 'refused', error: 'rejected' };
    }

    const read = readSubmission(form.fields, post.fields, post.files, form.policy);
    if (!read.ok) {
      return { kind: 'invalid', errors: read.errors };
    }
    const { submission } = read;

    const posted = post.fields.get(SUBMISSION_FIELD)?.[0] ?? '';
    const submissionId = uuidSchema.safeParse(posted).success ? posted : randomUUID();
    const earlier = await this.#inBrand(brandId, (tx) =>
      this.#options.writer.alreadyFiled(tx, brandId, submissionId),
    );
    if (earlier !== undefined) {
      return { kind: 'created', reference: earlier.reference };
    }

    const { limiter } = this.#options;
    if (!(await limiter.consume(WEB_FORM_IP_RULE, `${brandId}:${post.ip}`))) {
      return { kind: 'refused', error: 'rate_limited' };
    }
    if (!(await this.#captchaPasses(form, post, submissionId))) {
      return { kind: 'refused', error: 'captcha' };
    }
    if (!(await limiter.consume(WEB_FORM_ADDRESS_RULE, `${brandId}:${submission.email}`))) {
      return { kind: 'refused', error: 'rate_limited' };
    }

    const sink = this.#options.sink();
    try {
      const filed = await this.#inBrand(brandId, async (tx): Promise<FiledTicket | null> => {
        const gate = await isSenderBlocked(tx, brandId, { kind: 'email', value: submission.email });
        if (gate.blocked) {
          return null;
        }
        const departmentId =
          form.departmentId ?? (await this.#options.repository.firstDepartmentId(tx, brandId));
        /* c8 ignore next 3 -- a brand is created with a department and keeps at least one. */
        if (departmentId === undefined) {
          throw new Error('This brand has no department to file into');
        }
        return this.#options.writer.file({
          tx,
          brandId,
          departmentId,
          locale: form.locale,
          submissionId,
          submission,
          sink,
        });
      });
      return filed === null
        ? { kind: 'refused', error: 'rejected' }
        : { kind: 'created', reference: filed.reference };
    } catch (error) {
      await this.#discard(sink.uploaded);
      if (isUniqueViolation(error)) {
        // Two posts of one submission raced past the read above; the loser
        // answers what the winner filed.
        const winner = await this.#inBrand(brandId, (tx) =>
          this.#options.writer.alreadyFiled(tx, brandId, submissionId),
        );
        if (winner !== undefined) {
          return { kind: 'created', reference: winner.reference };
        }
      }
      throw error;
    }
  }

  async #read(
    tx: DbTransaction,
    brandId: string,
    lang: string | undefined,
    keys: BrandCaptchaKeys | null,
  ): Promise<LoadedForm | null> {
    const { repository } = this.#options;
    const brand = await repository.brand(tx, brandId);
    if (brand === undefined || !brand.active) {
      return null;
    }

    const locale = pageLocale(lang, brand.defaultLocale);
    const row = await repository.settings(tx, brandId);
    const policy = readContentPolicy(brand.contentPolicy);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'webform');
    const defList = await repository.ticketFieldDefs(tx);
    const fields = resolveFields(row?.fields ?? [], defList);
    const options = new Map(defList.map((def) => [def.key, def.options]));

    const captchaOn = row?.captchaEnabled ?? false;
    const state = !(row?.enabled ?? false)
      ? 'closed'
      : captchaOn && keys === null
        ? 'unavailable'
        : 'open';

    return {
      brand,
      locale,
      state,
      fields: fields
        .filter((field) => field.shown)
        .map((field) => {
          const key = customKeyOfRef(field.field);
          const label =
            key === null
              ? t(`fields.${field.field as 'name' | 'email' | 'subject' | 'message'}`)
              : locale === 'ar'
                ? (field.labelAr ?? field.label)
                : field.label;
          return {
            field: field.field,
            label,
            type: field.type,
            required: field.required,
            options: key === null ? [] : (options.get(key) ?? []),
          };
        }),
      attachments: attachmentsFor(policy, locale),
      captcha:
        captchaOn && keys !== null
          ? createCaptchaProvider(keys.provider, this.#options.captchaTransport).renderConfig(
              keys.siteKey,
              locale,
            )
          : null,
      thankYou: row?.thankYou[locale] ?? defaultThankYou(locale),
      departmentId: row?.departmentId ?? null,
      policy,
      keys: captchaOn ? keys : null,
    };
  }

  async #captchaPasses(
    form: LoadedForm,
    post: WebFormPost,
    submissionId: string,
  ): Promise<boolean> {
    if (form.captcha === null || form.keys === null) {
      return true;
    }
    const provider = createCaptchaProvider(form.keys.provider, this.#options.captchaTransport);
    const verdict = await provider.verify({
      secret: form.keys.secret,
      token: post.fields.get(form.captcha.responseField)?.[0] ?? '',
      remoteIp: post.ip,
      idempotencyKey: submissionId,
    });
    if (!verdict.success) {
      this.#options.log.warn(
        { brandId: form.brand.id, errorCodes: verdict.errorCodes },
        'web form CAPTCHA refused',
      );
    }
    return verdict.success;
  }

  #inBrand<T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.#options.db, systemContext(brandId, `webform:${brandId}`), fn);
  }

  async #discard(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.#options.removeObject(key);
      } catch (error) {
        this.#options.log.warn({ key, err: error }, 'could not remove an orphaned form upload');
      }
    }
  }
}
