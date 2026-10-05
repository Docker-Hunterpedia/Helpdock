import { createHash } from 'node:crypto';
import {
  type Api,
  type AssistantMessage,
  type Context,
  calculateCost,
  type Message,
  type Model,
  type ProviderStreamOptions,
  complete as piComplete,
} from '@mariozechner/pi-ai';
import { BudgetExceededError } from './guardrails/budget.js';
import { assertNoTools } from './guardrails/no-tools.js';
import { PiiRedactor, type Redaction, restorePii } from './guardrails/pii.js';
import type { AiCallRecord, AiPorts, AiTarget, ChatMessage } from './ports.js';
import { modelForCredential, resolveCredential } from './providers/credentials.js';
import { resolveModel } from './providers/models.js';

/**
 * `complete()`: the one way any feature asks a model for text (M7-01). In
 * order, for every call:
 *
 * 1. resolve the brand's model (its override, else the install default);
 * 2. redact PII from the system prompt and every message (M7-08), unless the
 *    brand turned the guardrail off;
 * 3. refuse with {@link BudgetExceededError} when a budget window is spent,
 *    logging the refusal;
 * 4. send through pi-ai with an explicit key and **no tools**;
 * 5. log the call to `ai_calls` — tokens, cost, latency, the redacted prompt
 *    and answer — whether it succeeded or failed.
 *
 * Streaming to the admin and the widget (ARCHITECTURE §10, `agent/`) arrives
 * with the features that stream; every one of them will log through the same
 * recorder.
 */

/** How the facade reaches a model. pi-ai's `complete` in production; the faux provider in tests. */
export type ModelTransport = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export const piTransport: ModelTransport = (model, context, options) =>
  piComplete(model, context, options);

export interface CompleteRequest {
  readonly brandId: string;
  /** Dotted feature name for the log, for example `assist.summarize`. */
  readonly feature: string;
  readonly ticketId?: string | null;
  /** The feature's own instructions, placed before the brand's system prompt. */
  readonly instructions?: string;
  readonly messages: readonly ChatMessage[];
  /** What the answer was grounded in, for the log (chunk ids and the like). */
  readonly sources?: readonly unknown[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface CompleteResult {
  readonly callId: string;
  /** The answer with every placeholder put back. */
  readonly text: string;
  /** The answer as the model wrote it, placeholders and all. */
  readonly redactedText: string;
  readonly redactions: readonly Redaction[];
  readonly provider: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

/** The provider failed, or answered with an error instead of text. Logged before it is thrown. */
export class AiProviderError extends Error {
  readonly callId: string;

  constructor(callId: string, reason: string) {
    super(`The AI provider failed: ${reason}`);
    this.name = 'AiProviderError';
    this.callId = callId;
  }
}

export interface CompleteDeps {
  readonly ports: AiPorts;
  readonly transport: ModelTransport;
  readonly clock: () => number;
}

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Earlier assistant turns are replayed as pi-ai assistant messages of the same model. */
const toPiMessages = (model: Model<Api>, messages: readonly ChatMessage[]): Message[] =>
  messages.map((message, index) =>
    message.role === 'user'
      ? { role: 'user', content: message.text, timestamp: index }
      : {
          role: 'assistant',
          content: [{ type: 'text', text: message.text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage,
          stopReason: 'stop',
          timestamp: index,
        },
  );

const textOf = (message: AssistantMessage): string =>
  message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

interface PreparedPrompt {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly redactions: readonly Redaction[];
}

const preparePrompt = (
  request: CompleteRequest,
  target: AiTarget,
  redact: boolean,
): PreparedPrompt => {
  const system = [request.instructions ?? '', target.systemPrompt]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n');
  if (!redact) {
    return { system, messages: request.messages, redactions: [] };
  }

  const redactor = new PiiRedactor();
  return {
    system: redactor.redact(system),
    messages: request.messages.map((message) => ({
      role: message.role,
      text: redactor.redact(message.text),
    })),
    redactions: redactor.redactions,
  };
};

export const createComplete =
  ({ ports, transport, clock }: CompleteDeps) =>
  async (request: CompleteRequest): Promise<CompleteResult> => {
    const target = await ports.target(request.brandId);
    const { piiRedaction } = await ports.guardrails(request.brandId);
    const prompt = preparePrompt(request, target, piiRedaction);
    const logged = { system: prompt.system, messages: prompt.messages };

    const record = (
      fields: Pick<AiCallRecord, 'status' | 'tokensIn' | 'tokensOut' | 'costUsd' | 'latencyMs'> &
        Pick<AiCallRecord, 'response' | 'error'>,
    ): Promise<string> =>
      ports.record({
        brandId: request.brandId,
        ticketId: request.ticketId ?? null,
        feature: request.feature,
        provider: target.provider.id,
        model: target.modelId,
        redactions: prompt.redactions,
        prompt: logged,
        promptHash: hashOf(logged),
        sources: request.sources ?? null,
        ...fields,
      });
    const failed = (reason: string, latencyMs = 0): Promise<string> =>
      record({
        status: 'error',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs,
        response: null,
        error: reason,
      });

    try {
      await ports.assertWithinBudget(request.brandId);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        await record({
          status: 'refused',
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: 0,
          response: null,
          error: error.message,
        });
      }
      throw error;
    }

    let model: Model<Api>;
    let apiKey: string;
    try {
      const credential = await resolveCredential(target.provider);
      if (credential.refreshed !== undefined) {
        await ports.saveCredentials(target.provider.id, credential.refreshed);
      }
      apiKey = credential.apiKey;
      model = modelForCredential(target.provider, resolveModel(target.provider, target.modelId));
    } catch (error) {
      throw new AiProviderError(await failed(messageOf(error)), messageOf(error));
    }

    const context: Context = {
      ...(prompt.system === '' ? {} : { systemPrompt: prompt.system }),
      messages: toPiMessages(model, prompt.messages),
    };
    assertNoTools(context);

    const started = clock();
    let answer: AssistantMessage;
    try {
      answer = await transport(model, context, {
        apiKey,
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      throw new AiProviderError(
        await failed(messageOf(error), clock() - started),
        messageOf(error),
      );
    }
    const latencyMs = clock() - started;

    if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
      const reason = answer.errorMessage ?? answer.stopReason;
      throw new AiProviderError(await failed(reason, latencyMs), reason);
    }

    const redactedText = textOf(answer);
    const fields = {
      tokensIn: answer.usage.input + answer.usage.cacheRead + answer.usage.cacheWrite,
      tokensOut: answer.usage.output,
      // Priced from the configured model's entry in pi-ai's registry (ADR 0018),
      // on a copy: `calculateCost` writes into the usage it is given.
      costUsd: calculateCost(model, structuredClone(answer.usage)).total,
    };
    const callId = await record({
      status: 'ok',
      ...fields,
      latencyMs,
      response: redactedText,
      error: null,
    });

    return {
      callId,
      text: restorePii(redactedText, prompt.redactions),
      redactedText,
      redactions: prompt.redactions,
      provider: target.provider.id,
      model: target.modelId,
      ...fields,
    };
  };
