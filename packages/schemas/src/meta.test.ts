import { describe, expect, it } from 'vitest';
import { errorResponseSchema } from './error.js';
import {
  META_ATTACHMENT_LIMITS,
  META_ERROR_MAX_LENGTH,
  META_HUMAN_AGENT_WINDOW_MS,
  META_PACE_MS,
  META_PLATFORMS,
  META_REPLY_WINDOW_MS,
  META_SEND_ATTEMPTS,
  META_SIGNATURE_HEADER,
  META_SUBSCRIBED_FIELDS,
  META_TEXT_LIMITS,
  META_TOKEN_HINT_LENGTH,
  META_TOKEN_KIND,
  metaAccountCreateRequestSchema,
  metaAccountHealth,
  metaAccountParamSchema,
  metaAccountSchema,
  metaAccountStatusResponseSchema,
  metaAccountUpdateRequestSchema,
  metaAppSchema,
  metaDeliveryParamSchema,
  metaDeliverySchema,
  metaDeliveryStatusSchema,
  metaFileRefSchema,
  metaRefusalDetailsSchema,
  metaRefusalSchema,
  metaSubscribeResultSchema,
  metaTestResultSchema,
  metaTicketContextResponseSchema,
  metaTicketContextSchema,
  metaTicketParamSchema,
  metaTokenTestRequestSchema,
  metaVerifyTokenRevealSchema,
  metaWebhookPath,
  replyWindowSchema,
} from './meta.js';

const DEPARTMENT = '01924f00-0000-7000-8000-0000000000aa';
const ACCOUNT = '01924f00-0000-7000-8000-0000000000bb';
const TICKET = '01924f00-0000-7000-8000-0000000000cc';
const MESSAGE = '01924f00-0000-7000-8000-0000000000dd';
const TOKEN = `EAAG${'x'.repeat(60)}`;
const STAMP = '2026-10-11T08:00:00.000Z';

describe('metaAccountHealth', () => {
  const earlier = new Date('2026-10-11T10:00:00Z');
  const later = new Date('2026-10-11T11:00:00Z');
  const connected = { status: 'connected' } as const;

  it('waits until the first webhook arrives', () => {
    expect(metaAccountHealth({ ...connected, lastEventAt: null, lastErrorAt: null })).toBe(
      'waiting',
    );
  });

  it('is healthy once a webhook arrived after the last error', () => {
    expect(metaAccountHealth({ ...connected, lastEventAt: later, lastErrorAt: earlier })).toBe(
      'healthy',
    );
    expect(metaAccountHealth({ ...connected, lastEventAt: later, lastErrorAt: null })).toBe(
      'healthy',
    );
  });

  it('is failing when the newest event is an error, whether or not a webhook came before', () => {
    expect(metaAccountHealth({ ...connected, lastEventAt: earlier, lastErrorAt: later })).toBe(
      'failing',
    );
    expect(metaAccountHealth({ ...connected, lastEventAt: null, lastErrorAt: later })).toBe(
      'failing',
    );
  });

  it('is failing whenever the account is not connected, however fresh its last webhook', () => {
    for (const status of ['token_expired', 'unsubscribed'] as const) {
      expect(metaAccountHealth({ status, lastEventAt: later, lastErrorAt: null })).toBe('failing');
      expect(metaAccountHealth({ status, lastEventAt: null, lastErrorAt: null })).toBe('failing');
    }
  });
});

describe('the constants the branches of M10 agree on', () => {
  it('names the three platforms, and the token each connects with', () => {
    expect(META_PLATFORMS).toEqual(['whatsapp', 'messenger', 'instagram']);
    expect(META_TOKEN_KIND).toEqual({
      whatsapp: 'system_user',
      messenger: 'page',
      instagram: 'instagram_user',
    });
  });

  it('counts the text limits in the unit each platform counts in', () => {
    expect(META_TEXT_LIMITS).toEqual({
      whatsapp: { unit: 'characters', max: 4_096 },
      messenger: { unit: 'characters', max: 2_000 },
      instagram: { unit: 'bytes', max: 1_000 },
    });
  });

  it('limits an outgoing file by platform and kind, and Instagram to PDF documents', () => {
    const mib = 1024 * 1024;

    expect(META_ATTACHMENT_LIMITS.whatsapp).toEqual({
      image: 5 * mib,
      audio: 16 * mib,
      video: 16 * mib,
      file: 100 * mib,
      fileTypes: null,
    });
    expect(META_ATTACHMENT_LIMITS.messenger).toEqual({
      image: 25 * mib,
      audio: 25 * mib,
      video: 25 * mib,
      file: 25 * mib,
      fileTypes: null,
    });
    expect(META_ATTACHMENT_LIMITS.instagram).toEqual({
      image: 8 * mib,
      audio: 25 * mib,
      video: 25 * mib,
      file: 25 * mib,
      fileTypes: ['application/pdf'],
    });
  });

  it('holds the windows and the pacing to the hour, the day and the second', () => {
    expect(META_REPLY_WINDOW_MS).toBe(86_400_000);
    expect(META_HUMAN_AGENT_WINDOW_MS).toBe(604_800_000);
    expect(META_PACE_MS).toBe(6_000);
    expect(META_SEND_ATTEMPTS).toBe(5);
    expect(META_ERROR_MAX_LENGTH).toBe(300);
    expect(META_TOKEN_HINT_LENGTH).toBe(4);
  });

  it('names the signature header in lower case and the one webhook route', () => {
    expect(META_SIGNATURE_HEADER).toBe('x-hub-signature-256');
    expect(metaWebhookPath()).toBe('/api/meta/webhook');
  });

  it('subscribes every platform to its messages and nothing it does not file', () => {
    for (const platform of META_PLATFORMS) {
      expect(META_SUBSCRIBED_FIELDS[platform]).toContain('messages');
    }
    expect(META_SUBSCRIBED_FIELDS.instagram).toContain('messaging_seen');
    expect(META_SUBSCRIBED_FIELDS.messenger).toContain('message_deliveries');
  });
});

describe('the account form', () => {
  const create = {
    platform: 'whatsapp',
    externalId: '106540352242922',
    accessToken: TOKEN,
    departmentId: DEPARTMENT,
  };

  it('accepts a phone number id and a token, trims them, and fills the defaults', () => {
    expect(
      metaAccountCreateRequestSchema.parse({
        ...create,
        externalId: ' 106540352242922 ',
        accessToken: ` ${TOKEN} `,
      }),
    ).toEqual({ ...create, humanAgentEnabled: false });
  });

  it('keeps a display name the person typed, trimmed', () => {
    expect(
      metaAccountCreateRequestSchema.parse({ ...create, displayName: ' Acme ' }).displayName,
    ).toBe('Acme');
  });

  it.each([
    ['an id with letters', { externalId: 'page-123' }],
    ['an id too short to be one', { externalId: '1234' }],
    ['an id too long to be one', { externalId: '1'.repeat(26) }],
    ['a token with a space in it', { accessToken: `${TOKEN} ${TOKEN}` }],
    ['a token too short to be real', { accessToken: 'short' }],
    ['a token past the limit', { accessToken: 'x'.repeat(1_025) }],
    ['a platform Meta does not have', { platform: 'telegram' }],
    ['an empty display name', { displayName: '   ' }],
    ['a department that is not an id', { departmentId: 'support' }],
  ])('refuses %s', (_name, override) => {
    expect(metaAccountCreateRequestSchema.safeParse({ ...create, ...override }).success).toBe(
      false,
    );
  });

  it('keeps the stored token when an update carries none', () => {
    const parsed = metaAccountUpdateRequestSchema.parse({
      displayName: 'Acme',
      departmentId: DEPARTMENT,
      humanAgentEnabled: true,
    });

    expect(parsed.accessToken).toBeUndefined();
    expect(parsed.humanAgentEnabled).toBe(true);
  });

  it('takes a replacement token under the same rules as the first', () => {
    const base = { displayName: 'Acme', departmentId: DEPARTMENT, humanAgentEnabled: false };

    expect(metaAccountUpdateRequestSchema.safeParse({ ...base, accessToken: TOKEN }).success).toBe(
      true,
    );
    expect(metaAccountUpdateRequestSchema.safeParse({ ...base, accessToken: 'no' }).success).toBe(
      false,
    );
  });

  it('asks for the platform, the id and the token to test a connection before it is stored', () => {
    expect(
      metaTokenTestRequestSchema.safeParse({
        platform: 'instagram',
        externalId: '17841400000000000',
        accessToken: TOKEN,
      }).success,
    ).toBe(true);
    expect(
      metaTokenTestRequestSchema.safeParse({ platform: 'instagram', accessToken: TOKEN }).success,
    ).toBe(false);
  });
});

describe('metaAccountSchema', () => {
  const account = {
    id: ACCOUNT,
    platform: 'whatsapp',
    externalId: '106540352242922',
    wabaId: '102290129340398',
    displayPhone: '+1 555 078 3881',
    username: null,
    displayName: 'Acme Support',
    departmentId: DEPARTMENT,
    departmentName: 'Support',
    tokenSet: true,
    tokenHint: '4f2a',
    tokenKind: 'system_user',
    tokenExpiresAt: null,
    tokenUpdatedAt: STAMP,
    tokenUpdatedByName: 'Mona',
    humanAgentEnabled: false,
    subscribedFields: ['messages'],
    subscribedAt: STAMP,
    status: 'connected',
    health: 'healthy',
    lastEventAt: STAMP,
    lastError: null,
    lastErrorAt: null,
    createdAt: STAMP,
  };

  it('reads an account the way the Channels table draws it', () => {
    expect(metaAccountSchema.parse(account)).toEqual(account);
  });

  it('carries no field that could hold the token, and drops one a careless caller adds', () => {
    const parsed = metaAccountSchema.parse({ ...account, accessToken: TOKEN, token: TOKEN });

    expect(Object.keys(parsed)).not.toContain('accessToken');
    expect(Object.keys(parsed)).not.toContain('token');
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  it('shows at most the last four characters of the token', () => {
    expect(metaAccountSchema.safeParse({ ...account, tokenHint: 'EAAG4f2a' }).success).toBe(false);
  });

  it('keeps Graph’s last words short enough to draw', () => {
    const long = 'x'.repeat(META_ERROR_MAX_LENGTH + 1);

    expect(metaAccountSchema.safeParse({ ...account, lastError: long }).success).toBe(false);
  });
});

describe('metaRefusalSchema', () => {
  it('lists exactly the refusals the Channels screen has a sentence for', () => {
    expect(metaRefusalSchema.options).toEqual([
      'token-invalid',
      'graph-unreachable',
      'account-taken',
      'token-other-account',
      'department-not-found',
      'app-not-configured',
      'platform-mismatch',
      'reply-window-closed',
      'subscribe-failed',
    ]);
  });
});

describe('metaRefusalDetailsSchema', () => {
  it('carries the platform and the two instants of a closed reply window', () => {
    expect(
      metaRefusalDetailsSchema.parse({ platform: 'whatsapp', anchorAt: STAMP, closedAt: STAMP }),
    ).toEqual({ platform: 'whatsapp', anchorAt: STAMP, closedAt: STAMP });
  });

  it('allows both instants to be null for a customer who never wrote', () => {
    expect(
      metaRefusalDetailsSchema.safeParse({ platform: 'messenger', anchorAt: null, closedAt: null })
        .success,
    ).toBe(true);
  });

  it('rejects a platform Helpdock has no channel for', () => {
    expect(
      metaRefusalDetailsSchema.safeParse({ platform: 'sms', anchorAt: null, closedAt: null })
        .success,
    ).toBe(false);
  });

  it('travels in the error body beside the reason', () => {
    const body = {
      error: {
        code: 'conflict',
        message: 'The reply window is closed',
        requestId: 'req_1',
        meta: {
          reason: 'reply-window-closed',
          details: { platform: 'instagram', anchorAt: STAMP, closedAt: STAMP },
        },
      },
    };

    expect(errorResponseSchema.parse(body).error.meta?.details?.platform).toBe('instagram');
    expect(
      errorResponseSchema.safeParse({
        error: { ...body.error, meta: { reason: 'not-a-refusal' } },
      }).success,
    ).toBe(false);
  });
});

describe('metaTestResultSchema', () => {
  it('describes a recognised account, with the Instagram handle and expiry when Graph gave them', () => {
    expect(
      metaTestResultSchema.parse({
        ok: true,
        platform: 'instagram',
        externalId: '17841400000000000',
        name: 'Acme',
        username: 'acme',
        tokenExpiresAt: STAMP,
      }),
    ).toMatchObject({ ok: true, username: 'acme' });
    expect(
      metaTestResultSchema.parse({
        ok: true,
        platform: 'messenger',
        externalId: '106540352242922',
        name: 'Acme Page',
      }),
    ).not.toHaveProperty('username');
  });

  it('describes a refusal as a kind and Graph’s own words', () => {
    for (const kind of ['token', 'refused', 'connect'] as const) {
      expect(
        metaTestResultSchema.safeParse({ ok: false, kind, detail: 'Invalid OAuth access token' })
          .success,
      ).toBe(true);
    }
    expect(metaTestResultSchema.safeParse({ ok: false, kind: 'nope', detail: null }).success).toBe(
      false,
    );
  });
});

describe('metaSubscribeResultSchema', () => {
  it('reports the fields Graph subscribed, or why it did not', () => {
    expect(
      metaSubscribeResultSchema.safeParse({
        ok: true,
        subscribedFields: ['messages'],
        subscribedAt: STAMP,
      }).success,
    ).toBe(true);
    expect(metaSubscribeResultSchema.safeParse({ ok: false, detail: null }).success).toBe(true);
  });
});

describe('metaAccountStatusResponseSchema', () => {
  const status = {
    status: 'connected',
    health: 'healthy',
    lastEventAt: STAMP,
    lastError: null,
    lastErrorAt: null,
    tokenExpiresAt: null,
    subscribedFields: ['messages'],
    subscribedAt: STAMP,
    subscriptionCheckedAt: STAMP,
    tokenValid: true,
    subscribedApps: [{ id: '1234567890', name: 'Helpdock', subscribedFields: ['messages'] }],
    liveError: null,
    activity: { lastReplyAt: STAMP, failedSends: 0, refusedSends: 1, openTickets: 2 },
  };

  it('reads the row’s facts beside what Graph said now', () => {
    expect(metaAccountStatusResponseSchema.parse(status)).toEqual(status);
  });

  it('keeps null for what Graph could not be asked, with the reason', () => {
    expect(
      metaAccountStatusResponseSchema.safeParse({
        ...status,
        tokenValid: null,
        subscribedApps: null,
        liveError: 'Graph could not be reached',
      }).success,
    ).toBe(true);
  });

  it('refuses a negative count in the activity card', () => {
    expect(
      metaAccountStatusResponseSchema.safeParse({
        ...status,
        activity: { ...status.activity, failedSends: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('the App card', () => {
  it('shows the app id, whether each secret is set and where Meta posts, and carries no secret', () => {
    const app = {
      appIdSet: true,
      appId: '1290457718832406',
      appSecretSet: true,
      instagramAppSecretSet: false,
      graphVersion: 'v25.0',
      callbackUrl: 'https://support.example.com/api/meta/webhook',
      verifyTokenHint: 'a1b2',
      secretsLockedByEnv: ['meta.appSecret'],
    };

    expect(metaAppSchema.parse({ ...app, appSecret: 's3cret' })).toEqual(app);
  });

  it('names the Graph version in the shape the client accepts', () => {
    const app = {
      appIdSet: false,
      appId: '',
      appSecretSet: false,
      instagramAppSecretSet: false,
      callbackUrl: 'https://support.example.com/api/meta/webhook',
      verifyTokenHint: '',
      secretsLockedByEnv: [],
    };

    expect(metaAppSchema.safeParse({ ...app, graphVersion: 'v25.0' }).success).toBe(true);
    expect(metaAppSchema.safeParse({ ...app, graphVersion: '25' }).success).toBe(false);
  });

  it('shows a verify token once and never an empty one', () => {
    expect(metaVerifyTokenRevealSchema.safeParse({ verifyToken: 'abc' }).success).toBe(true);
    expect(metaVerifyTokenRevealSchema.safeParse({ verifyToken: '' }).success).toBe(false);
  });
});

describe('deliveries and the ticket context', () => {
  const delivery = {
    id: ACCOUNT,
    ticketMessageId: MESSAGE,
    status: 'delivered',
    partsSent: 2,
    partsTotal: 3,
    leftOut: [],
    attempts: 1,
    lastError: null,
    errorCode: null,
    tag: null,
    templateName: null,
    sentAt: STAMP,
    deliveredAt: STAMP,
    readAt: null,
    failedAt: null,
  };

  it('knows every state a reply passes through', () => {
    expect(metaDeliveryStatusSchema.options).toEqual([
      'queued',
      'sent',
      'delivered',
      'read',
      'failed',
      'refused',
    ]);
    expect(metaDeliverySchema.parse(delivery)).toEqual(delivery);
  });

  it('names a file the platform would not take, and why, beside the parts that went', () => {
    const left = {
      attachmentId: MESSAGE,
      name: 'warranty-terms.docx',
      reason: 'unsupported-type',
    };

    expect(metaDeliverySchema.parse({ ...delivery, leftOut: [left] }).leftOut).toEqual([left]);
    expect(
      metaDeliverySchema.safeParse({ ...delivery, leftOut: [{ ...left, reason: 'infected' }] })
        .success,
    ).toBe(false);
    expect(metaDeliverySchema.safeParse({ ...delivery, partsTotal: -1 }).success).toBe(false);
  });

  it('describes the three windows with the one date each of them has', () => {
    expect(replyWindowSchema.parse({ state: 'open', closesAt: STAMP })).toEqual({
      state: 'open',
      closesAt: STAMP,
    });
    expect(replyWindowSchema.parse({ state: 'human_agent', closesAt: STAMP })).toEqual({
      state: 'human_agent',
      closesAt: STAMP,
    });
    expect(replyWindowSchema.parse({ state: 'closed', closedAt: null })).toEqual({
      state: 'closed',
      closedAt: null,
    });
    expect(replyWindowSchema.safeParse({ state: 'open' }).success).toBe(false);
    expect(replyWindowSchema.safeParse({ state: 'expired' }).success).toBe(false);
  });

  it('reads a conversation for the ticket view, with the optional facts left out when unknown', () => {
    const context = metaTicketContextSchema.parse({
      account: {
        id: ACCOUNT,
        platform: 'whatsapp',
        externalId: '106540352242922',
        displayName: 'Acme Support',
      },
      customerId: 'US.13491208655302741918',
      phone: '+16505551234',
      phoneVerified: true,
      profileName: 'Sheena Nelson',
      window: { state: 'open', closesAt: STAMP },
    });

    expect(context.phoneVerified).toBe(true);
    expect(context).not.toHaveProperty('username');
    expect(context.account).not.toHaveProperty('username');
    expect(context.account).not.toHaveProperty('displayPhone');
  });

  it('carries a WhatsApp number’s display form for the channel chip', () => {
    const context = metaTicketContextSchema.parse({
      account: {
        id: ACCOUNT,
        platform: 'whatsapp',
        externalId: '106540352242922',
        displayName: 'Acme Support',
        displayPhone: '+1 555 0142',
      },
      customerId: 'US.13491208655302741918',
      phoneVerified: false,
      window: { state: 'closed', closedAt: STAMP },
    });

    expect(context.account.displayPhone).toBe('+1 555 0142');
  });

  it('answers a ticket with no Meta conversation as a null context and no deliveries', () => {
    expect(metaTicketContextResponseSchema.parse({ context: null, deliveries: [] })).toEqual({
      context: null,
      deliveries: [],
    });
  });
});

describe('the route parameters', () => {
  const BRAND = '01924f00-0000-7000-8000-0000000000ee';

  it('name a brand and an account, a ticket, or a ticket’s delivery', () => {
    expect(metaAccountParamSchema.parse({ brandId: BRAND, accountId: ACCOUNT })).toEqual({
      brandId: BRAND,
      accountId: ACCOUNT,
    });
    expect(metaTicketParamSchema.parse({ brandId: BRAND, ticketId: TICKET })).toEqual({
      brandId: BRAND,
      ticketId: TICKET,
    });
    expect(
      metaDeliveryParamSchema.parse({ brandId: BRAND, ticketId: TICKET, deliveryId: MESSAGE }),
    ).toEqual({ brandId: BRAND, ticketId: TICKET, deliveryId: MESSAGE });
  });

  it('refuse a segment that is not an id', () => {
    expect(metaAccountParamSchema.safeParse({ brandId: BRAND, accountId: 'x' }).success).toBe(
      false,
    );
    expect(metaTicketParamSchema.safeParse({ brandId: BRAND, ticketId: '1' }).success).toBe(false);
    expect(metaDeliveryParamSchema.safeParse({ brandId: BRAND, ticketId: TICKET }).success).toBe(
      false,
    );
  });
});

describe('metaFileRefSchema', () => {
  const media = {
    kind: 'whatsapp_media',
    type: 'image',
    mediaId: '1234567890',
    mimeType: 'image/jpeg',
    sha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
  };

  it('names a WhatsApp media id with the digest to check the bytes against', () => {
    expect(metaFileRefSchema.parse(media)).toEqual(media);
    expect(
      metaFileRefSchema.parse({ ...media, type: 'audio', voice: true, sha256: null }),
    ).toMatchObject({ voice: true, sha256: null });
    expect(
      metaFileRefSchema.parse({ ...media, type: 'document', filename: 'invoice.pdf' }),
    ).toMatchObject({ filename: 'invoice.pdf' });
  });

  it('names a CDN link and what the platform called it', () => {
    const ref = {
      kind: 'cdn_url',
      url: 'https://scontent.xx.fbcdn.net/v/t1/a.jpg?x=1',
      type: 'image',
    };

    expect(metaFileRefSchema.parse(ref)).toEqual(ref);
  });

  it.each([
    ['a link that is not http(s)', { kind: 'cdn_url', url: 'file:///etc/passwd', type: 'image' }],
    ['a link that is no URL', { kind: 'cdn_url', url: 'not a url', type: 'image' }],
    ['a media type WhatsApp does not have', { ...media, type: 'gif' }],
    ['an empty media id', { ...media, mediaId: '' }],
    ['a kind nobody fetches', { kind: 'attach', url: 'https://x.test/a', type: 'image' }],
  ])('refuses %s', (_label, ref) => {
    expect(metaFileRefSchema.safeParse(ref).success).toBe(false);
  });
});
