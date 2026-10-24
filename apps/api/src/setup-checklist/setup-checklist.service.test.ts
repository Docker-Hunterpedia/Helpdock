import type { Settings } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import type { AiRepository } from '../ai/ai.repository.js';
import type { RowFacts, SetupChecklistRepository } from './setup-checklist.repository.js';
import { SetupChecklistService } from './setup-checklist.service.js';

const tx = {} as DbTransaction;
const context = { tx, brandId: 'brand-1', userId: 'user-1' };

const noRows: RowFacts = {
  channel: false,
  teammate: false,
  businessHours: false,
  slaPolicy: false,
  assignment: false,
  reply: false,
  article: false,
  firstTicket: false,
};

interface Setup {
  readonly brand?: { providerId: string | null; modelId: string | null };
  readonly install?: { provider: string; model: string };
  readonly providers?: readonly string[];
  readonly dismissed?: boolean;
}

function serviceWith({
  brand,
  install = { provider: '', model: '' },
  providers = [],
  dismissed = false,
}: Setup = {}) {
  const repository = {
    rowFacts: vi.fn(async () => noRows),
    isDismissed: vi.fn(async () => dismissed),
    dismiss: vi.fn(async () => undefined),
  };
  const ai = { settings: vi.fn(async () => brand) };
  const values: Record<string, unknown> = {
    'ai.defaultProvider': install.provider,
    'ai.defaultModel': install.model,
    'ai.providers': providers.map((id) => ({ id })),
  };
  const settings = { get: vi.fn(async (key: string) => values[key]) };

  return {
    repository,
    service: new SetupChecklistService(
      repository as unknown as SetupChecklistRepository,
      ai as unknown as AiRepository,
      settings as unknown as Pick<Settings, 'get'>,
    ),
  };
}

const aiStep = async (setup: Setup): Promise<boolean | undefined> =>
  (await serviceWith(setup).service.view(context)).steps.find((step) => step.id === 'aiProvider')
    ?.done;

describe('SetupChecklistService', () => {
  describe('the AI provider step', () => {
    it('is undone while neither the brand nor the install names a model', async () => {
      expect(await aiStep({})).toBe(false);
    });

    it('is done by the install’s default provider and model', async () => {
      expect(
        await aiStep({
          install: { provider: 'openai', model: 'gpt-4o-mini' },
          providers: ['openai'],
        }),
      ).toBe(true);
    });

    it('is done by the brand’s own pair when the install has no default', async () => {
      expect(
        await aiStep({
          brand: { providerId: 'ollama', modelId: 'qwen3:8b' },
          providers: ['ollama'],
        }),
      ).toBe(true);
    });

    it('is undone when the provider named is no longer on the install’s list', async () => {
      expect(
        await aiStep({ install: { provider: 'openai', model: 'gpt-4o-mini' }, providers: [] }),
      ).toBe(false);
    });

    it('is undone when a provider is set and no model is', async () => {
      expect(
        await aiStep({ install: { provider: 'openai', model: '' }, providers: ['openai'] }),
      ).toBe(false);
    });
  });

  it('carries whether the reader hid it', async () => {
    expect((await serviceWith({ dismissed: true }).service.view(context)).dismissed).toBe(true);
  });

  it('hides it for the reader and answers with the checklist as it now reads', async () => {
    const { service, repository } = serviceWith({ dismissed: true });

    const checklist = await service.dismiss(context);

    expect(repository.dismiss).toHaveBeenCalledWith(tx, 'brand-1', 'user-1');
    expect(checklist.dismissed).toBe(true);
  });
});
