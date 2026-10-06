import { fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiProviderError } from './complete.js';
import { BudgetExceededError } from './guardrails/budget.js';
import { type Ai, createAi } from './index.js';
import { AiNotConfiguredError } from './ports.js';
import {
  createFakeModel,
  type FakeModel,
  fakeEmbeddingsServer,
  InMemoryAiPorts,
} from './testing.js';

const brandId = '0192f4d2-0000-7000-8000-000000000001';

let fake: FakeModel;
let ports: InMemoryAiPorts;
let ai: Ai;
let now = 0;

beforeEach(() => {
  fake = createFakeModel();
  ports = new InMemoryAiPorts({ systemPrompt: 'Answer as Acme support.' });
  now = 1_000;
  ai = createAi({
    ports,
    http: fakeEmbeddingsServer(4).http,
    transport: async (model, context, options) => {
      now += 250;
      return fake.transport(model, context, options);
    },
    clock: () => now,
  });
});

afterEach(() => fake.unregister());

describe('complete()', () => {
  it("uses the brand's Arabic prompt for an Arabic conversation, and its own otherwise", async () => {
    ports.systemPromptAr = 'أجب بلهجة ودودة.';
    fake.reply('حسنًا.', 'Fine.');

    await ai.complete({
      brandId,
      feature: 'auto_reply',
      locale: 'ar',
      messages: [{ role: 'user', text: 'مرحبا' }],
    });
    await ai.complete({
      brandId,
      feature: 'auto_reply',
      locale: 'en',
      messages: [{ role: 'user', text: 'Hi' }],
    });

    expect(fake.sent[0]?.context.systemPrompt).toBe('أجب بلهجة ودودة.');
    expect(fake.sent[1]?.context.systemPrompt).toBe('Answer as Acme support.');
  });

  it('sends the configured model with an explicit key and logs the call with its cost', async () => {
    fake.reply('Refunds take five days.');

    const result = await ai.complete({
      brandId,
      feature: 'assist.suggest_reply',
      ticketId: '0192f4d2-0000-7000-8000-0000000000aa',
      instructions: 'Suggest a reply.',
      messages: [{ role: 'user', text: 'Where is my refund?' }],
      sources: ['chunk-1'],
    });

    expect(result.text).toBe('Refunds take five days.');
    expect(fake.sent[0]?.model).toEqual({ provider: 'openai', id: 'gpt-4o-mini' });
    expect(fake.sent[0]?.apiKey).toBe('sk-fake');
    expect(fake.sent[0]?.context.systemPrompt).toBe('Suggest a reply.\n\nAnswer as Acme support.');

    const [call] = ports.calls;
    expect(call).toMatchObject({
      brandId,
      feature: 'assist.suggest_reply',
      provider: 'fake',
      model: 'gpt-4o-mini',
      status: 'ok',
      latencyMs: 250,
      response: 'Refunds take five days.',
      sources: ['chunk-1'],
      error: null,
    });
    expect(call?.tokensIn).toBeGreaterThan(0);
    expect(call?.tokensOut).toBeGreaterThan(0);
    // gpt-4o-mini's price in pi-ai's registry: 0.15 in, 0.60 out, per million tokens.
    expect(call?.costUsd).toBeCloseTo(
      ((call?.tokensIn ?? 0) * 0.15 + (call?.tokensOut ?? 0) * 0.6) / 1e6,
      12,
    );
    expect(call?.costUsd).toBeGreaterThan(0);
    expect(call?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.callId).toBe('call-1');
  });

  it('redacts PII before the model sees it and restores it in the answer', async () => {
    fake.reply('We will write to [EMAIL_1] today.');

    const result = await ai.complete({
      brandId,
      feature: 'assist.suggest_reply',
      messages: [{ role: 'user', text: 'Mail me at mona@example.com, card 4111 1111 1111 1111' }],
    });

    const sentText = JSON.stringify(fake.sent[0]?.context.messages);
    expect(sentText).not.toContain('mona@example.com');
    expect(sentText).not.toContain('4111');
    expect(sentText).toContain('[EMAIL_1]');
    expect(result.text).toBe('We will write to mona@example.com today.');
    expect(result.redactedText).toBe('We will write to [EMAIL_1] today.');
    expect(ports.calls[0]?.redactions).toHaveLength(2);
    expect(JSON.stringify(ports.calls[0]?.prompt)).not.toContain('mona@example.com');
  });

  it('sends the text unredacted when the brand turned the guardrail off', async () => {
    ports.piiRedaction = false;
    fake.reply('ok');

    await ai.complete({
      brandId,
      feature: 'test',
      messages: [{ role: 'user', text: 'a@example.com' }],
    });

    expect(JSON.stringify(fake.sent[0]?.context.messages)).toContain('a@example.com');
  });

  it('replays earlier assistant turns', async () => {
    fake.reply('Five days.');

    await ai.complete({
      brandId,
      feature: 'autoreply',
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello, how can I help?' },
        { role: 'user', text: 'Refund time?' },
      ],
    });

    expect(fake.sent[0]?.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('never offers the model a tool', async () => {
    fake.reply('ok');

    await ai.complete({ brandId, feature: 'test', messages: [{ role: 'user', text: 'Hi' }] });

    expect(fake.sent[0]?.context.tools).toBeUndefined();
  });

  it('ignores a tool call a model makes anyway, and keeps only its text', async () => {
    fake.reply(
      fauxAssistantMessage([
        { type: 'text', text: 'Done.' },
        fauxToolCall('refund', { amount: 9 }),
      ]),
    );

    const result = await ai.complete({
      brandId,
      feature: 'test',
      messages: [{ role: 'user', text: 'Refund me' }],
    });

    expect(result.text).toBe('Done.');
  });

  it('refuses with BudgetExceededError, logs the refusal and calls no model', async () => {
    ports.exceedBudget(brandId);

    await expect(
      ai.complete({ brandId, feature: 'autoreply', messages: [{ role: 'user', text: 'Hi' }] }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(fake.sent).toHaveLength(0);
    expect(ports.calls[0]).toMatchObject({ status: 'refused', costUsd: 0 });
  });

  it('logs a provider failure and throws AiProviderError naming the logged call', async () => {
    fake.reply(fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'rate limited' }));

    const failure = ai.complete({
      brandId,
      feature: 'test',
      messages: [{ role: 'user', text: 'Hi' }],
    });

    await expect(failure).rejects.toBeInstanceOf(AiProviderError);
    await expect(failure).rejects.toMatchObject({ callId: 'call-1' });
    expect(ports.calls[0]).toMatchObject({ status: 'error', error: 'rate limited' });
  });

  it('logs a model the provider does not offer as a failed call', async () => {
    ports.modelId = 'no-such-model';

    await expect(
      ai.complete({ brandId, feature: 'test', messages: [{ role: 'user', text: 'Hi' }] }),
    ).rejects.toThrow(/no model no-such-model/);
    expect(ports.calls[0]?.status).toBe('error');
  });

  it('throws AiNotConfiguredError, and logs nothing, while no model is configured', async () => {
    ports.provider = null;

    await expect(
      ai.complete({ brandId, feature: 'test', messages: [{ role: 'user', text: 'Hi' }] }),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(ports.calls).toHaveLength(0);
  });
});
