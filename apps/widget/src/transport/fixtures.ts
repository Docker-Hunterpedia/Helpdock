import { semantic } from '@helpdock/ui/tokens.json';
import type { MockOptions } from './mock.js';
import type {
  AgentSummary,
  ArticleDetail,
  Availability,
  ContentPolicy,
  WidgetConfig,
  WidgetLocale,
  WidgetMode,
} from './types.js';

/**
 * The sample brand the boards draw (Helpdock support, Lina Haddad on Billing),
 * in both languages. Used by the unit tests and the Playwright harness only;
 * none of it reaches `widget.js`.
 */
export const LINA: AgentSummary = { id: 'agent-lina', name: 'Lina Haddad', avatar_url: null };
const KARIM: AgentSummary = { id: 'agent-karim', name: 'Karim Nasser', avatar_url: null };
const SARA: AgentSummary = { id: 'agent-sara', name: 'Sara Ali', avatar_url: null };

const MB = 1024 * 1024;

export const samplePolicy: ContentPolicy = {
  image: { enabled: true, max_bytes: 10 * MB, allowed_mime: ['image/*'] },
  video: { enabled: true, max_bytes: 25 * MB, allowed_mime: ['video/mp4', 'video/webm'] },
  voice: {
    enabled: true,
    max_bytes: 5 * MB,
    allowed_mime: ['audio/webm', 'audio/mp4', 'audio/ogg'],
    max_seconds: 120,
  },
  file: { enabled: true, max_bytes: 10 * MB, allowed_mime: ['application/pdf', 'text/plain'] },
  max_attachments_per_message: 5,
};

export type AvailabilityState = Availability['state'];

export function sampleAvailability(state: AvailabilityState): Availability {
  return {
    state,
    next_open_at: state === 'closed' ? '2026-09-27T05:00:00Z' : null,
    timezone: 'Asia/Dubai',
    agents_online: state === 'online' ? [LINA, KARIM, SARA] : [],
  };
}

const ARTICLES: Record<WidgetLocale, ArticleDetail[]> = {
  en: [
    {
      id: 'refund-timelines',
      title: 'Refund timelines',
      excerpt: 'Card refunds land 3–5 business days after we issue them…',
      section: 'Returns & refunds',
      url: 'https://help.example.com/en/articles/refund-timelines',
      updated_at: '2026-09-12T10:00:00Z',
      reading_minutes: 2,
      body_html:
        '<p>We issue your refund as soon as the return reaches our warehouse. How long it takes to show depends on how you paid:</p><ul><li>Card: 3–5 business days</li><li>Bank transfer: up to 7 business days</li><li>Gift card: right away</li></ul><p>If the refund has not arrived after that, send us the order number and we will trace it with the bank.</p><script>window.hacked = true</script>',
    },
    {
      id: 'start-return',
      title: 'How to start a return',
      excerpt: 'Open your order, choose the items and print the label…',
      section: 'Returns & refunds',
      url: 'https://help.example.com/en/articles/start-return',
      updated_at: '2026-09-02T10:00:00Z',
      reading_minutes: 3,
      body_html: '<p>Open your order, choose the items and print the label.</p>',
    },
    {
      id: 'change-address',
      title: 'Change the delivery address of an order',
      excerpt: 'You can change the address until the order ships…',
      section: 'Orders',
      url: 'https://help.example.com/en/articles/change-address',
      updated_at: '2026-08-20T10:00:00Z',
      reading_minutes: 1,
      body_html: '<p>You can change the address until the order ships.</p>',
    },
    {
      id: 'gift-exchange',
      title: 'Exchanging a gift',
      excerpt: 'Use the gift receipt number instead of the order number…',
      section: 'Returns & refunds',
      url: null,
      updated_at: '2026-09-01T10:00:00Z',
      reading_minutes: 1,
      body_html: '<p>Use the gift receipt number instead of the order number.</p>',
    },
  ],
  ar: [
    {
      id: 'refund-timelines',
      title: 'مدة استرداد المبالغ',
      excerpt: 'تصل المبالغ المستردة إلى البطاقة خلال 3 إلى 5 أيام عمل…',
      section: 'الإرجاع والاسترداد',
      url: 'https://help.example.com/ar/articles/refund-timelines',
      updated_at: '2026-09-12T10:00:00Z',
      reading_minutes: 2,
      body_html:
        '<p>نصدر المبلغ المسترد فور وصول المرتجع إلى مستودعنا. تعتمد مدة ظهوره على طريقة الدفع:</p><ul><li>البطاقة: من 3 إلى 5 أيام عمل</li><li>التحويل البنكي: حتى 7 أيام عمل</li><li>بطاقة الهدية: فوراً</li></ul>',
    },
    {
      id: 'start-return',
      title: 'كيف تبدأ عملية إرجاع',
      excerpt: 'افتح طلبك واختر المنتجات واطبع الملصق…',
      section: 'الإرجاع والاسترداد',
      url: 'https://help.example.com/ar/articles/start-return',
      updated_at: '2026-09-02T10:00:00Z',
      reading_minutes: 3,
      body_html: '<p>افتح طلبك واختر المنتجات واطبع الملصق.</p>',
    },
    {
      id: 'change-address',
      title: 'تغيير عنوان التوصيل لطلب',
      excerpt: 'يمكنك تغيير العنوان حتى شحن الطلب…',
      section: 'الطلبات',
      url: 'https://help.example.com/ar/articles/change-address',
      updated_at: '2026-08-20T10:00:00Z',
      reading_minutes: 1,
      body_html: '<p>يمكنك تغيير العنوان حتى شحن الطلب.</p>',
    },
    {
      id: 'gift-exchange',
      title: 'استبدال هدية',
      excerpt: 'استخدم رقم إيصال الهدية بدلاً من رقم الطلب…',
      section: 'الإرجاع والاسترداد',
      url: null,
      updated_at: '2026-09-01T10:00:00Z',
      reading_minutes: 1,
      body_html: '<p>استخدم رقم إيصال الهدية بدلاً من رقم الطلب.</p>',
    },
  ],
};

/** The popular list is the first three; the fourth is found only by searching (M5-10). */
const POPULAR = 3;

const GREETING: Record<WidgetLocale, string> = {
  en: 'Hi, welcome to Helpdock support. Ask us about orders, returns or your account and someone from the team will answer here.',
  ar: 'مرحباً بك في دعم Helpdock. اسألنا عن الطلبات أو الإرجاع أو حسابك وسيجيبك أحد أعضاء الفريق هنا.',
};

const ORDER_FIELD: Record<WidgetLocale, string> = { en: 'Order number', ar: 'رقم الطلب' };

export interface SampleOptions {
  readonly mode?: WidgetMode;
  readonly availability?: AvailabilityState;
  readonly preChat?: boolean;
  readonly transcript?: boolean;
  readonly scheme?: 'light' | 'dark' | 'auto';
  readonly policy?: ContentPolicy;
}

export function sampleConfig(locale: WidgetLocale, options: SampleOptions = {}): WidgetConfig {
  return {
    brand: { id: 'brand-helpdock', name: 'Helpdock' },
    mode: options.mode ?? 'chat',
    default_locale: 'en',
    theme: {
      mode: options.scheme ?? 'light',
      tokens: { light: semantic.light, dark: semantic.dark },
      radius: { md: 6, lg: 10 },
      font_family: {
        sans: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        arabic: "'IBM Plex Sans Arabic', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
        mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      },
      fonts: [],
      launcher: { style: 'icon', label: null, position: 'inline-end' },
    },
    greeting: GREETING[locale],
    availability: sampleAvailability(options.availability ?? 'online'),
    pre_chat: {
      enabled: options.preChat ?? false,
      fields: [{ key: 'order', label: ORDER_FIELD[locale], type: 'text', required: false }],
    },
    contact_form: {
      fields: [{ key: 'order', label: ORDER_FIELD[locale], type: 'text', required: false }],
    },
    content_policy: options.policy ?? samplePolicy,
    transcript_enabled: options.transcript ?? true,
    captcha: null,
    popular_articles: ARTICLES[locale]
      .slice(0, POPULAR)
      .map(({ body_html, updated_at, reading_minutes, ...summary }) => summary),
    help_center_url: `https://help.example.com/${locale}`,
    show_powered_by: true,
  };
}

export function sampleMockOptions(locale: WidgetLocale, options: SampleOptions = {}): MockOptions {
  return {
    config: (requested) => sampleConfig(requested, options),
    articles: ARTICLES[locale],
  };
}
