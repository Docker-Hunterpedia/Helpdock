/**
 * The hosted web form (M4-09) in a real browser without a database: the api's
 * own request handling, renderer, body parser, CSP and fonts, over a Fastify
 * server, with the brand and its form held in memory. What happens to a
 * submission in Postgres and Redis is `web-form.integration.test.ts`; what this
 * server lets Playwright prove is the page itself — both languages, the error
 * summary, the success page, axe.
 *
 * It runs the build (`pnpm --filter @helpdock/api build`), not the sources, as
 * the admin's api project does.
 *
 * | Path | Brand |
 * |---|---|
 * | `/contact/<OPEN_BRAND>` | Helpdock, form on, two custom fields |
 * | `/contact/<CLOSED_BRAND>` | Closed Co, form off |
 */
import { contentPolicySchema } from '@helpdock/schemas';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  INBOUND_PARSE_ROUTE,
  registerFormBodies,
} from '../dist/channels/inbound/inbound-parse-body.js';
import { loadFonts } from '../dist/static/fonts.js';
import { readSubmission } from '../dist/web-form/submission.js';
import { WEB_FORM_ROUTE } from '../dist/web-form/web-form-page.controller.js';
import { readFormBody, WebFormPage } from '../dist/web-form/web-form-page.js';
import { attachmentsFor, pageLocale } from '../dist/web-form/web-form-public.service.js';

import { CLOSED_BRAND, OPEN_BRAND, PORT, REFERENCE } from './fixtures.ts';

const policy = contentPolicySchema.parse({});

const labels = {
  en: { name: 'Name', email: 'Email', subject: 'Subject', message: 'Message' },
  ar: { name: 'الاسم', email: 'البريد الإلكتروني', subject: 'الموضوع', message: 'الرسالة' },
} as const;

const loadForm = (brandId: string, lang: string | undefined) => {
  if (brandId !== OPEN_BRAND && brandId !== CLOSED_BRAND) {
    return null;
  }
  const locale = pageLocale(lang, 'en');
  const builtin = (
    field: 'name' | 'email' | 'subject' | 'message',
    type: string,
    required: boolean,
  ) => ({
    field,
    label: labels[locale][field],
    type,
    required,
    options: [],
  });

  return {
    brand: {
      id: brandId,
      name: brandId === OPEN_BRAND ? 'Helpdock' : 'Closed Co',
      defaultLocale: 'en',
      prefix: 'HD',
      active: true,
      contentPolicy: {},
    },
    locale,
    state: brandId === OPEN_BRAND ? 'open' : 'closed',
    fields: [
      builtin('name', 'name', true),
      builtin('email', 'email', true),
      builtin('subject', 'subject', true),
      {
        field: 'custom:order_number',
        label: locale === 'ar' ? 'رقم الطلب' : 'Order number',
        type: 'text',
        required: false,
        options: [],
      },
      {
        field: 'custom:product',
        label: locale === 'ar' ? 'المنتج' : 'Product',
        type: 'select',
        required: false,
        options: ['Desk', 'Widget'],
      },
      builtin('message', 'long_text', true),
    ],
    attachments: attachmentsFor(policy, locale),
    captcha: null,
    thankYou:
      locale === 'ar'
        ? 'شكراً، وصلتنا رسالتك. رقم طلبك {{ticket.number}}، وسنرد عليك بالبريد الإلكتروني خلال يوم عادةً.'
        : 'Thanks, we have your message. Your reference is {{ticket.number}}; we reply by email, usually within a day.',
    departmentId: null,
    policy,
    keys: null,
  };
};

const page = new WebFormPage({
  resolveHost: async () => null,
  log: { error: (fields, message) => process.stderr.write(`${message} ${String(fields.err)}\n`) },
  forms: {
    load: async (brandId, lang) => loadForm(brandId, lang) as never,
    submit: async (form, post) => {
      const read = readSubmission(form.fields, post.fields, post.files, form.policy);
      return read.ok
        ? { kind: 'created', reference: REFERENCE }
        : { kind: 'invalid', errors: read.errors };
    },
  },
});

const fonts = loadFonts();
const server = Fastify();
registerFormBodies(server, [INBOUND_PARSE_ROUTE, WEB_FORM_ROUTE]);

server.get('/_hd/fonts/:file', async (request, reply) => {
  const found = fonts.get((request.params as { file: string }).file);
  if (found === undefined) {
    return reply.code(404).send();
  }
  return reply.type(found.contentType).send(found.body);
});

const handle = async (request: FastifyRequest, reply: FastifyReply, withBody: boolean) => {
  const { brandId } = request.params as { brandId: string };
  const { lang } = request.query as { lang?: string };
  const body = withBody
    ? ((await readFormBody(String(request.headers['content-type'] ?? ''), request.body)) ?? {
        fields: new Map(),
        files: [],
      })
    : undefined;
  const response = await page.handle({
    host: undefined,
    brandId,
    lang,
    ip: request.ip,
    ...(body === undefined ? {} : { body }),
  });
  return reply
    .code(response.status)
    .header('content-security-policy', response.contentSecurityPolicy)
    .type('text/html; charset=utf-8')
    .send(response.html);
};

server.get('/contact/:brandId', (request, reply) => handle(request, reply, false));
server.post('/contact/:brandId', (request, reply) => handle(request, reply, true));

await server.listen({ port: PORT, host: '127.0.0.1' });
process.stdout.write(`web form e2e server on http://127.0.0.1:${String(PORT)}\n`);
