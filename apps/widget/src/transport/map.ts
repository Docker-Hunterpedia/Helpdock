import type {
  MediaPolicy,
  WidgetArticle as WireArticle,
  WidgetAttachment as WireAttachment,
  WidgetAvailability as WireAvailability,
  WidgetConfig as WireConfig,
  ContentPolicy as WireContentPolicy,
  WidgetConversation as WireConversation,
  WidgetCsat as WireCsat,
  WidgetPrechatFieldView as WireField,
  WidgetMessage as WireMessage,
} from '@helpdock/schemas';
import type {
  AgentSummary,
  ArticleDetail,
  Attachment,
  AttachmentKind,
  Availability,
  ContentPolicy,
  ConversationStatus,
  ConversationSummary,
  CsatCard,
  FieldDefinition,
  KindPolicy,
  WidgetConfig,
  WidgetMessage,
} from './types.js';

/**
 * The api speaks camelCase, like the rest of the api and
 * `docs/guides/widget-protocol.md`; the UI's types (`types.ts`) are shaped for
 * drawing. These pure functions are the one place the two meet, so every
 * translation is unit-tested and the UI never sees a wire shape.
 */

/** The recorder's cap; the api's policy caps bytes, not seconds. */
export const VOICE_MAX_SECONDS = 120;

/**
 * `open` is the calendar, `agentsOnline` the people: together, the header's
 * three states. `agents` is who, by first name, and empty when the brand hides
 * agents; the api sends no staff id, so the UI's key is the position.
 */
export const toAvailability = (wire: WireAvailability): Availability => ({
  state: !wire.open ? 'closed' : wire.agentsOnline ? 'online' : 'open_offline',
  next_open_at: wire.nextOpenAt,
  timezone: wire.timezone,
  agents_online: wire.agents.map((agent, index) => ({
    id: `online-${index}`,
    name: agent.name,
    avatar_url: agent.avatarUrl,
  })),
});

const toKindPolicy = (policy: MediaPolicy): KindPolicy => ({
  enabled: policy.enabled,
  max_bytes: policy.maxBytes,
  allowed_mime: policy.allowedMime,
});

export const toContentPolicy = (wire: WireContentPolicy): ContentPolicy => ({
  image: toKindPolicy(wire.image),
  video: toKindPolicy(wire.video),
  voice: { ...toKindPolicy(wire.voice), max_seconds: VOICE_MAX_SECONDS },
  file: toKindPolicy(wire.file),
  max_attachments_per_message: wire.maxAttachmentsPerMessage,
});

/**
 * The extra fields a form asks. Name and email are drawn by the forms
 * themselves, so the built-in two are left out; a field type the widget has
 * no control for is asked as text.
 */
export const toFields = (fields: readonly WireField[]): FieldDefinition[] =>
  fields
    .filter((field) => field.kind === 'custom')
    .map((field) => ({
      key: field.key,
      label: field.label ?? field.key,
      type: 'text',
      required: field.required,
    }));

export const toConfig = (wire: WireConfig): WidgetConfig => ({
  brand: { id: wire.brandId, name: wire.brandName },
  mode: wire.mode,
  default_locale: wire.defaultLocale,
  theme: {
    mode: wire.theme.colorScheme,
    tokens: wire.theme.tokens,
    radius: wire.theme.radius,
    font_family: wire.theme.fontFamily,
    fonts: wire.theme.fonts.map((font) => ({
      family: font.family,
      weight: font.weight,
      url: font.url,
      ...(font.unicodeRange === null ? {} : { unicode_range: font.unicodeRange }),
    })),
    launcher: {
      style: wire.theme.launcher.style,
      label: wire.theme.launcher.label,
      position: wire.theme.launcher.position === 'start' ? 'inline-start' : 'inline-end',
    },
  },
  greeting: wire.greeting,
  availability: toAvailability(wire.availability),
  pre_chat: { enabled: wire.prechat.enabled, fields: toFields(wire.prechat.fields) },
  contact_form: { fields: toFields(wire.contactForm.fields) },
  content_policy: toContentPolicy(wire.contentPolicy),
  transcript_enabled: wire.transcriptEnabled,
  captcha:
    wire.captcha === null
      ? null
      : { provider: wire.captcha.provider, site_key: wire.captcha.siteKey },
  popular_articles: wire.popularArticles,
  help_center_url: wire.helpCenterUrl,
  show_powered_by: wire.showPoweredBy,
});

/** M5-10: one help center article, read inside the widget. */
export const toArticle = (wire: WireArticle): ArticleDetail => ({
  id: wire.id,
  title: wire.title,
  excerpt: wire.excerpt,
  section: wire.section,
  url: wire.url,
  updated_at: wire.updatedAt,
  reading_minutes: wire.readingMinutes,
  body_html: wire.bodyHtml,
});

/** The pipeline calls the bytes audio; the composer calls them a voice message. */
export const toWireKind = (kind: AttachmentKind): WireAttachment['kind'] =>
  kind === 'voice' ? 'audio' : kind;

export const toAttachment = (wire: WireAttachment): Attachment => ({
  id: wire.id,
  kind: wire.kind === 'audio' ? 'voice' : wire.kind,
  name: wire.name,
  mime: wire.mime,
  size_bytes: wire.size,
  duration_seconds: null,
});

/**
 * An agent as the thread draws them. With "show the agent's name" off the
 * api sends no name, and the brand speaks instead (M4-08).
 */
export const agentOf = (name: string | null, avatarUrl: string | null, brandName: string) =>
  ({
    id: name === null ? 'brand' : `agent:${name}`,
    name: name ?? brandName,
    avatar_url: avatarUrl,
  }) satisfies AgentSummary;

export const toMessage = (wire: WireMessage, brandName: string): WidgetMessage => ({
  id: wire.id,
  conversation_id: wire.conversationId,
  seq: wire.seq,
  client_id: wire.clientId,
  author:
    wire.author === 'visitor'
      ? { kind: 'visitor' }
      : wire.author === 'system'
        ? { kind: 'system' }
        : wire.author === 'ai'
          ? { kind: 'ai' }
          : {
              kind: 'agent',
              agent: agentOf(wire.agent?.name ?? null, wire.agent?.avatarUrl ?? null, brandName),
            },
  body: wire.text,
  attachments: wire.attachments.map(toAttachment),
  system: null,
  ...(wire.ai === undefined
    ? {}
    : {
        ai: {
          kind: wire.ai.kind,
          citations: wire.ai.citations.map((citation) => ({
            marker: citation.marker,
            title: citation.title,
            url: citation.url,
            article_id: citation.articleId,
          })),
          feedback: wire.ai.feedback,
        },
      }),
  created_at: wire.createdAt,
});

/**
 * A conversation as the header draws it. `queued` until an agent holds it:
 * the api's queue position says which, and a closed conversation has ended.
 */
export const statusOf = (
  wire: Pick<WireConversation, 'state'>,
  position: number | null,
): ConversationStatus =>
  wire.state === 'closed' ? 'ended' : position === null ? 'active' : 'queued';

export const toConversation = (
  wire: WireConversation,
  position: number | null,
  visitorEmail: string | null,
): ConversationSummary => ({
  id: wire.id,
  status: statusOf(wire, position),
  agent: null,
  department: null,
  visitor_email: visitorEmail,
  read_seq: 0,
  ai_handed_off: wire.aiHandedOff ?? false,
});

/** M8-06: the satisfaction card, as the UI draws it. */
export const toCsat = (wire: WireCsat): CsatCard => ({
  state: wire.state,
  rating: wire.rating,
  comment: wire.comment,
  skipped_at: wire.skippedAt,
});
