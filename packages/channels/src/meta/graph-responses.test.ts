import { describe, expect, it } from 'vitest';
import { GraphApiFailure } from './errors.js';
import {
  fixtureMid,
  fixtureWamid,
  graphMediaMeta,
  graphRefreshToken,
  graphSendOk,
  graphSubscribedApp,
  graphSubscribedApps,
  META_FIXTURE,
} from './fixtures.js';
import {
  GRAPH_IDENTITY_FIELDS,
  graphDebugTokenSchema,
  graphIdentityName,
  graphIdentitySchema,
  graphMediaMetaSchema,
  graphMediaUploadSchema,
  graphRefreshTokenSchema,
  graphSendResponseSchema,
  graphSubscribedAppsSchema,
  graphSuccessSchema,
  parseGraph,
  subscribedAppsOf,
} from './graph-responses.js';

describe('graphSendResponseSchema', () => {
  it('reads the wamid of a WhatsApp send', () => {
    expect(graphSendResponseSchema.parse(graphSendOk('whatsapp', { id: fixtureWamid(5) }))).toBe(
      fixtureWamid(5),
    );
  });

  it.each(['messenger', 'instagram'] as const)('reads the message id of a %s send', (platform) => {
    expect(graphSendResponseSchema.parse(graphSendOk(platform, { id: fixtureMid(5) }))).toBe(
      fixtureMid(5),
    );
  });

  it.each([
    ['an empty object', {}],
    ['no messages', { messages: [] }],
    ['a message with no id', { messages: [{ message_status: 'accepted' }] }],
    ['an empty message id', { message_id: '' }],
    ['text', 'ok'],
  ])('refuses %s, because a send that names nothing cannot be recorded', (_label, body) => {
    expect(graphSendResponseSchema.safeParse(body).success).toBe(false);
  });

  it('keeps reading when Graph adds fields', () => {
    expect(
      graphSendResponseSchema.parse({
        messaging_product: 'whatsapp',
        contacts: [],
        messages: [{ id: fixtureWamid(1), message_status: 'accepted' }],
        future: true,
      }),
    ).toBe(fixtureWamid(1));
  });
});

describe('graphMediaUploadSchema', () => {
  it('reads the media id, whether Graph wrote it as a string or a number', () => {
    expect(graphMediaUploadSchema.parse({ id: '1479537139650973' }).id).toBe('1479537139650973');
    expect(graphMediaUploadSchema.parse({ id: 1234567 }).id).toBe('1234567');
    expect(graphMediaUploadSchema.safeParse({}).success).toBe(false);
  });
});

describe('graphMediaMetaSchema', () => {
  const meta = graphMediaMeta({
    id: '555',
    url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=555',
    sha256: 'ab'.repeat(32),
    fileSize: 1234,
  });

  it('reads where the bytes are, their type, digest and size', () => {
    expect(graphMediaMetaSchema.parse(meta)).toMatchObject({
      id: '555',
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=555',
      mime_type: 'image/jpeg',
      sha256: 'ab'.repeat(32),
      file_size: '1234',
    });
  });

  it('accepts a size written as a number', () => {
    expect(graphMediaMetaSchema.safeParse({ ...meta, file_size: 1234 }).success).toBe(true);
  });

  it.each([
    ['no URL', { ...meta, url: undefined }],
    ['a URL that is not http(s)', { ...meta, url: 'file:///etc/passwd' }],
    ['a URL that is no URL', { ...meta, url: 'lookaside' }],
  ])('refuses %s', (_label, body) => {
    expect(graphMediaMetaSchema.safeParse(body).success).toBe(false);
  });
});

describe('graphIdentitySchema', () => {
  it('reads a WhatsApp number', () => {
    const identity = graphIdentitySchema.parse({
      id: META_FIXTURE.phoneNumberId,
      display_phone_number: '+1 555 078 3881',
      verified_name: 'Acme Support',
    });

    expect(graphIdentityName(identity)).toBe('Acme Support');
  });

  it('reads a Page by its name and an Instagram account by its name before its handle', () => {
    expect(graphIdentityName(graphIdentitySchema.parse({ id: '1', name: 'Acme Page' }))).toBe(
      'Acme Page',
    );
    expect(
      graphIdentityName(graphIdentitySchema.parse({ id: '2', username: 'acme', name: 'Acme' })),
    ).toBe('Acme');
    expect(graphIdentityName(graphIdentitySchema.parse({ id: '2', username: 'acme' }))).toBe(
      'acme',
    );
  });

  it('falls back on the id when Graph said nothing else', () => {
    expect(graphIdentityName(graphIdentitySchema.parse({ id: 99 }))).toBe('99');
  });

  it('asks for the fields each platform keeps its name in', () => {
    expect(GRAPH_IDENTITY_FIELDS).toEqual({
      whatsapp: 'id,display_phone_number,verified_name',
      messenger: 'id,name',
      instagram: 'id,username,name',
    });
  });
});

describe('subscribedAppsOf', () => {
  it('reads the apps of a Page or an Instagram account with their fields', () => {
    const body = graphSubscribedAppsSchema.parse(
      graphSubscribedApps('messenger', { fields: ['messages', 'message_echoes'] }),
    );

    expect(subscribedAppsOf(body)).toEqual([
      {
        id: META_FIXTURE.appId,
        name: 'Helpdock',
        subscribedFields: ['messages', 'message_echoes'],
      },
    ]);
  });

  it('reads the app WhatsApp wraps in its own object, with no fields', () => {
    const body = graphSubscribedAppsSchema.parse(graphSubscribedApps('whatsapp'));

    expect(subscribedAppsOf(body)).toEqual([
      { id: META_FIXTURE.appId, name: 'Helpdock', subscribedFields: [] },
    ]);
  });

  it('reads no apps as none, and skips an entry that names no app', () => {
    expect(subscribedAppsOf(graphSubscribedAppsSchema.parse({ data: [] }))).toEqual([]);
    expect(
      subscribedAppsOf(graphSubscribedAppsSchema.parse({ data: [{ name: 'Anonymous' }] })),
    ).toEqual([]);
  });

  it('lists several apps in the order Graph gave them', () => {
    const body = graphSubscribedAppsSchema.parse({
      data: [
        graphSubscribedApp('messenger', { appId: '111', name: 'One' }),
        graphSubscribedApp('messenger', { appId: '222', name: 'Two' }),
      ],
    });

    expect(subscribedAppsOf(body).map((app) => app.id)).toEqual(['111', '222']);
  });

  it('refuses a body with no data array', () => {
    expect(graphSubscribedAppsSchema.safeParse({}).success).toBe(false);
  });
});

describe('graphDebugTokenSchema', () => {
  it('reads a valid token with its expiry', () => {
    const body = graphDebugTokenSchema.parse({
      data: { is_valid: true, expires_at: 1_800_000_000, type: 'USER', app_id: 123, scopes: ['a'] },
    });

    expect(body.data).toMatchObject({ is_valid: true, expires_at: 1_800_000_000, app_id: '123' });
  });

  it('reads the reason a token is not valid', () => {
    const body = graphDebugTokenSchema.parse({
      data: { is_valid: false, error: { code: 190, message: 'Session has expired' } },
    });

    expect(body.data.error).toEqual({ code: 190, message: 'Session has expired' });
  });

  it('refuses a body with no data', () => {
    expect(graphDebugTokenSchema.safeParse({ is_valid: true }).success).toBe(false);
  });
});

describe('graphRefreshTokenSchema', () => {
  it('reads the new token and how long it lives', () => {
    expect(
      graphRefreshTokenSchema.parse(
        graphRefreshToken({ accessToken: 'IGAA-new', expiresInSeconds: 5_184_000 }),
      ),
    ).toMatchObject({ access_token: 'IGAA-new', expires_in: 5_184_000 });
  });

  it.each([
    ['no token', { expires_in: 5_184_000 }],
    ['an empty token', { access_token: '', expires_in: 5_184_000 }],
    ['no lifetime', { access_token: 'IGAA-new' }],
    ['a lifetime of nothing', { access_token: 'IGAA-new', expires_in: 0 }],
  ])('refuses %s', (_label, body) => {
    expect(graphRefreshTokenSchema.safeParse(body).success).toBe(false);
  });
});

describe('parseGraph', () => {
  it('returns what the schema read', () => {
    expect(parseGraph(graphMediaUploadSchema, { id: '7' }, 'an upload')).toEqual({ id: '7' });
  });

  it('throws a permanent failure that names what was expected and quotes nothing of the body', () => {
    const secret = 'EAAGsecret0123456789abcdef';
    const failure = (() => {
      try {
        parseGraph(graphMediaUploadSchema, { surprise: secret }, 'to the upload', secret);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(failure).toBeInstanceOf(GraphApiFailure);
    expect(failure).toMatchObject({ kind: 'permanent', permanent: true });
    expect((failure as GraphApiFailure).detail).toBe(
      'Graph answered to the upload in a shape Helpdock does not know',
    );
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
});

describe('graphSuccessSchema', () => {
  it('reads the answer to a subscription: true, false, and no word at all', () => {
    expect(graphSuccessSchema.parse({ success: true })).toEqual({ success: true });
    expect(graphSuccessSchema.parse({ success: false })).toEqual({ success: false });
    expect(graphSuccessSchema.parse({})).toEqual({});
    expect(graphSuccessSchema.parse(undefined)).toBeUndefined();
    expect(graphSuccessSchema.parse(null)).toBeNull();
  });

  it('refuses what is not an object with a boolean success', () => {
    expect(graphSuccessSchema.safeParse({ success: 'yes' }).success).toBe(false);
    expect(graphSuccessSchema.safeParse('ok').success).toBe(false);
  });
});
