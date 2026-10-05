import type {
  ContentPolicy,
  WidgetConfig as WireConfig,
  WidgetConversation as WireConversation,
  WidgetMessage as WireMessage,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  agentOf,
  toArticle,
  toAvailability,
  toConfig,
  toConversation,
  toMessage,
  toWireKind,
  VOICE_MAX_SECONDS,
} from './map.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const policy = (maxBytes: number) => ({ enabled: true, maxBytes, allowedMime: ['image/png'] });

const contentPolicy: ContentPolicy = {
  text: true,
  emoji: true,
  image: policy(10),
  video: policy(20),
  voice: policy(30),
  file: { enabled: false, maxBytes: 40, allowedMime: ['application/pdf'] },
  maxAttachmentsPerMessage: 3,
  keepOriginals: false,
};

const wireConfig: WireConfig = {
  brandId: BRAND,
  brandName: 'Acme',
  defaultLocale: 'en',
  locale: 'ar',
  mode: 'chat_articles',
  appearance: {
    mode: 'chat_articles',
    accent: '#0F766E',
    colorScheme: 'dark',
    position: 'start',
    launcher: 'icon_text',
    greetingEn: 'Hi',
    greetingAr: 'مرحبا',
  },
  theme: {
    colorScheme: 'dark',
    tokens: { light: { 'bg.canvas': '#FFFFFF' }, dark: { 'bg.canvas': '#000000' } },
    radius: { md: 6, lg: 10 },
    fontFamily: { sans: 'Plex', arabic: 'Plex Arabic', mono: 'Plex Mono' },
    fonts: [
      { family: 'Plex', weight: 400, url: 'https://h/widget-fonts/a.woff2', unicodeRange: 'U+0' },
      { family: 'Plex', weight: 600, url: 'https://h/widget-fonts/b.woff2', unicodeRange: null },
    ],
    launcher: { style: 'icon_text', label: null, position: 'start' },
  },
  greeting: 'مرحبا',
  prechat: {
    enabled: true,
    fields: [
      { key: 'name', kind: 'name', required: true, label: null, type: 'text', options: [] },
      {
        key: 'order',
        kind: 'custom',
        required: false,
        label: 'رقم الطلب',
        type: 'number',
        options: [],
      },
      { key: 'plan', kind: 'custom', required: true, label: null, type: 'select', options: ['a'] },
    ],
  },
  contactForm: {
    fields: [
      {
        key: 'order',
        kind: 'custom',
        required: false,
        label: 'رقم الطلب',
        type: 'text',
        options: [],
      },
    ],
  },
  showAgentIdentity: true,
  whenUnavailable: 'form',
  transcriptEnabled: true,
  contentPolicy,
  captcha: { provider: 'turnstile', siteKey: '0x4AAA' },
  signedIdentity: false,
  availability: {
    open: true,
    nextOpenAt: null,
    timezone: 'Asia/Dubai',
    agentsOnline: false,
    agents: [],
  },
  popularArticles: [
    { id: 'a1', title: 'Refunds', excerpt: 'Card refunds…', section: null, url: 'https://hc/a1' },
  ],
  helpCenterUrl: 'https://help.acme.test',
  showPoweredBy: true,
};

describe('toConfig', () => {
  it("gives the UI everything it draws from, in the UI's names", () => {
    expect(toConfig(wireConfig)).toEqual({
      brand: { id: BRAND, name: 'Acme' },
      mode: 'chat_articles',
      default_locale: 'en',
      theme: {
        mode: 'dark',
        tokens: wireConfig.theme.tokens,
        radius: { md: 6, lg: 10 },
        font_family: { sans: 'Plex', arabic: 'Plex Arabic', mono: 'Plex Mono' },
        fonts: [
          {
            family: 'Plex',
            weight: 400,
            url: 'https://h/widget-fonts/a.woff2',
            unicode_range: 'U+0',
          },
          { family: 'Plex', weight: 600, url: 'https://h/widget-fonts/b.woff2' },
        ],
        launcher: { style: 'icon_text', label: null, position: 'inline-start' },
      },
      greeting: 'مرحبا',
      availability: {
        state: 'open_offline',
        next_open_at: null,
        timezone: 'Asia/Dubai',
        agents_online: [],
      },
      pre_chat: {
        enabled: true,
        fields: [
          { key: 'order', label: 'رقم الطلب', type: 'text', required: false },
          { key: 'plan', label: 'plan', type: 'text', required: true },
        ],
      },
      contact_form: {
        fields: [{ key: 'order', label: 'رقم الطلب', type: 'text', required: false }],
      },
      content_policy: {
        image: { enabled: true, max_bytes: 10, allowed_mime: ['image/png'] },
        video: { enabled: true, max_bytes: 20, allowed_mime: ['image/png'] },
        voice: {
          enabled: true,
          max_bytes: 30,
          allowed_mime: ['image/png'],
          max_seconds: VOICE_MAX_SECONDS,
        },
        file: { enabled: false, max_bytes: 40, allowed_mime: ['application/pdf'] },
        max_attachments_per_message: 3,
      },
      transcript_enabled: true,
      captcha: { provider: 'turnstile', site_key: '0x4AAA' },
      popular_articles: wireConfig.popularArticles,
      help_center_url: 'https://help.acme.test',
      show_powered_by: true,
    });
  });

  it('puts the launcher at the inline end unless the brand chose the start', () => {
    const end = toConfig({
      ...wireConfig,
      theme: { ...wireConfig.theme, launcher: { ...wireConfig.theme.launcher, position: 'end' } },
    });

    expect(end.theme.launcher.position).toBe('inline-end');
  });
});

describe('toAvailability', () => {
  it('derives the three header states from the calendar and the people', () => {
    const at = (open: boolean, agentsOnline: boolean) =>
      toAvailability({ open, agentsOnline, agents: [], nextOpenAt: null, timezone: 'UTC' }).state;

    expect(at(true, true)).toBe('online');
    expect(at(true, false)).toBe('open_offline');
    expect(at(false, true)).toBe('closed');
    expect(at(false, false)).toBe('closed');
  });

  it('carries who is online, keyed by position because the api sends no staff id', () => {
    const availability = toAvailability({
      open: true,
      agentsOnline: true,
      agents: [
        { name: 'Lina', avatarUrl: null },
        { name: 'Sara', avatarUrl: 'https://cdn.acme.test/sara.webp' },
      ],
      nextOpenAt: null,
      timezone: 'UTC',
    });

    expect(availability.agents_online).toEqual([
      { id: 'online-0', name: 'Lina', avatar_url: null },
      { id: 'online-1', name: 'Sara', avatar_url: 'https://cdn.acme.test/sara.webp' },
    ]);
  });
});

const wireMessage = (fields: Partial<WireMessage>): WireMessage => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
  conversationId: CONVERSATION,
  seq: 4,
  clientId: null,
  author: 'agent',
  agent: null,
  text: 'Hello',
  html: '<p>Hello</p>',
  attachments: [],
  createdAt: '2026-09-27T10:00:00.000Z',
  ...fields,
});

describe('toMessage', () => {
  it('maps a visitor message, its text and a voice note', () => {
    const message = toMessage(
      wireMessage({
        author: 'visitor',
        clientId: CONVERSATION,
        html: null,
        attachments: [
          {
            id: 'f1',
            kind: 'audio',
            name: 'voice.ogg',
            mime: 'audio/ogg',
            size: 900,
            status: 'ready',
          },
        ],
      }),
      'Acme',
    );

    expect(message).toEqual({
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
      conversation_id: CONVERSATION,
      seq: 4,
      client_id: CONVERSATION,
      author: { kind: 'visitor' },
      body: 'Hello',
      attachments: [
        {
          id: 'f1',
          kind: 'voice',
          name: 'voice.ogg',
          mime: 'audio/ogg',
          size_bytes: 900,
          duration_seconds: null,
        },
      ],
      system: null,
      created_at: '2026-09-27T10:00:00.000Z',
    });
  });

  it('names the agent when the brand shows agents, and the brand when it does not', () => {
    const named = toMessage(wireMessage({ agent: { name: 'Lina', avatarUrl: null } }), 'Acme');
    const hidden = toMessage(wireMessage({ agent: null }), 'Acme');
    const ai = toMessage(wireMessage({ author: 'ai' }), 'Acme');

    expect(named.author).toEqual({
      kind: 'agent',
      agent: { id: 'agent:Lina', name: 'Lina', avatar_url: null },
    });
    expect(hidden.author).toEqual({
      kind: 'agent',
      agent: { id: 'brand', name: 'Acme', avatar_url: null },
    });
    expect(ai.author.kind).toBe('agent');
    expect(toMessage(wireMessage({ author: 'system' }), 'Acme').author).toEqual({ kind: 'system' });
  });
});

describe('toConversation', () => {
  const wire: WireConversation = {
    id: CONVERSATION,
    reference: 'HD-1042',
    subject: 'Refund',
    state: 'open',
    channel: 'chat',
    lastSeq: 3,
    continuedById: null,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:00:00.000Z',
  };

  it('is queued while it has a queue position, active once an agent holds it, ended once closed', () => {
    expect(toConversation(wire, 2, 'omar@example.com')).toEqual({
      id: CONVERSATION,
      status: 'queued',
      agent: null,
      department: null,
      visitor_email: 'omar@example.com',
      read_seq: 0,
    });
    expect(toConversation(wire, null, null).status).toBe('active');
    expect(toConversation({ ...wire, state: 'closed' }, 2, null).status).toBe('ended');
  });
});

describe('toWireKind and agentOf', () => {
  it('calls a voice note audio on the wire', () => {
    expect(toWireKind('voice')).toBe('audio');
    expect(toWireKind('image')).toBe('image');
  });

  it('falls back to the brand for an agent without a name', () => {
    expect(agentOf(null, null, 'Acme').name).toBe('Acme');
  });
});

describe('toArticle (M5-10)', () => {
  it('turns the api’s article into the UI’s, address and all', () => {
    expect(
      toArticle({
        id: 'a1',
        title: 'Refund timelines',
        excerpt: 'How long a refund takes',
        section: null,
        url: null,
        locale: 'ar',
        updatedAt: '2026-09-12T10:00:00.000Z',
        readingMinutes: 3,
        bodyHtml: '<p>Body</p>',
      }),
    ).toEqual({
      id: 'a1',
      title: 'Refund timelines',
      excerpt: 'How long a refund takes',
      section: null,
      url: null,
      updated_at: '2026-09-12T10:00:00.000Z',
      reading_minutes: 3,
      body_html: '<p>Body</p>',
    });
  });
});
