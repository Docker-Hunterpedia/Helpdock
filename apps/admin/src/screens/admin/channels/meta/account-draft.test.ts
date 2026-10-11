import { describe, expect, it } from 'vitest';
import {
  MOCK_MESSENGER_ACCOUNT,
  MOCK_WHATSAPP_ACCOUNT,
  MockMetaApi,
} from '../../../../meta/mock-api.js';
import {
  draftFromAccount,
  isDraftDirty,
  looksLikeId,
  looksLikeToken,
  validateDraft,
} from './account-draft.js';

const account = async (id: string) => new MockMetaApi().account('brand', id);

describe('draftFromAccount', () => {
  it('starts from the saved routing and Human Agent, keeping the token', async () => {
    const messenger = await account(MOCK_MESSENGER_ACCOUNT);

    expect(draftFromAccount(messenger)).toEqual({
      departmentId: messenger.departmentId,
      humanAgentEnabled: false,
      token: null,
    });
  });
});

describe('isDraftDirty', () => {
  it('is clean until the department or the switch changes, or Replace is pressed', async () => {
    const saved = draftFromAccount(await account(MOCK_MESSENGER_ACCOUNT));

    expect(isDraftDirty(saved, saved)).toBe(false);
    expect(isDraftDirty({ ...saved, departmentId: 'other' }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, humanAgentEnabled: true }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, token: '' }, saved)).toBe(true);
  });
});

describe('looksLikeToken', () => {
  it('wants one run of at least sixteen characters with no space', () => {
    expect(looksLikeToken(' EAAGabcdefghijklmnop ')).toBe(true);
    expect(looksLikeToken('short')).toBe(false);
    expect(looksLikeToken('EAAG has a space inside it')).toBe(false);
    expect(looksLikeToken(`EAAG${'x'.repeat(1_100)}`)).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });
});

describe('looksLikeId', () => {
  it('wants the digits Meta issues, five to twenty-five of them', () => {
    expect(looksLikeId(' 109384715520331 ')).toBe(true);
    expect(looksLikeId('+1 555 0142')).toBe(false);
    expect(looksLikeId('1234')).toBe(false);
    expect(looksLikeId('abc12345')).toBe(false);
  });
});

describe('validateDraft', () => {
  it('turns a clean draft into a request that keeps the token', async () => {
    const messenger = await account(MOCK_MESSENGER_ACCOUNT);
    const draft = { ...draftFromAccount(messenger), humanAgentEnabled: true };

    expect(validateDraft(draft, messenger)).toEqual({
      ok: true,
      request: {
        displayName: 'Helpdock',
        departmentId: messenger.departmentId,
        humanAgentEnabled: true,
      },
    });
  });

  it('sends a replaced token trimmed', async () => {
    const messenger = await account(MOCK_MESSENGER_ACCOUNT);
    const draft = { ...draftFromAccount(messenger), token: '  EAAGnewTokenAbcdefghijkl  ' };

    expect(validateDraft(draft, messenger)).toMatchObject({
      ok: true,
      request: { accessToken: 'EAAGnewTokenAbcdefghijkl' },
    });
  });

  it('refuses a replaced token that is not one, before asking the api', async () => {
    const messenger = await account(MOCK_MESSENGER_ACCOUNT);

    expect(validateDraft({ ...draftFromAccount(messenger), token: 'nope' }, messenger)).toEqual({
      ok: false,
      errors: { token: 'malformed' },
    });
  });

  it('never turns Human Agent on for a WhatsApp number', async () => {
    const whatsapp = await account(MOCK_WHATSAPP_ACCOUNT);

    expect(
      validateDraft({ ...draftFromAccount(whatsapp), humanAgentEnabled: true }, whatsapp),
    ).toMatchObject({ ok: true, request: { humanAgentEnabled: false } });
  });
});
