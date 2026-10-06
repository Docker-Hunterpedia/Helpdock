import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Ai,
  bagOfWordsVector,
  createAi,
  createMockEvalModel,
  DOMAIN_RULES_9,
  detectLocale,
  type EvalItem,
  type EvalItemResult,
  type EvalKnowledgeCounts,
  type EvalModels,
  type EvalReport,
  type EvalSuite,
  fakeEmbeddingsServer,
  type HttpTransport,
  InMemoryAiPorts,
  JUDGE_FEATURE,
  JUDGE_MAX_TOKENS,
  type JudgeVerdict,
  judgeInstructions,
  judgePayload,
  type MockFlaws,
  type ModelTransport,
  parseJudgeVerdict,
  readSelfAssessment,
  renderEvalMarkdown,
  scoreResults,
  validateCitations,
} from '@helpdock/ai';
import type { AiProviderConfig } from '@helpdock/config';
import { aiCalls } from '@helpdock/db';
import { eq } from 'drizzle-orm';
import { safeAiTransport } from '../../ai/ai-http.js';
import { generateAutoReply } from '../../ai/auto-reply/auto-reply-generate.js';
import { createAiRuntime } from '../../ai/db-ai-ports.js';
import {
  createQueryEmbedder,
  createRetriever,
  type RetrievedChunk,
  type Retriever,
} from '../../knowledge/retrieval/retrieve.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { silentJobLogger } from '../media.js';
import type { EvalConfig } from './config.js';
import { loadEvalKnowledge } from './knowledge.js';
import { type EvalStack, startEvalStack } from './stack.js';

/**
 * One evaluation run (M7-11, DOMAIN-RULES §9): the install prepared once —
 * models configured, the fixture loaded and embedded — then every item of
 * the set through `generateAutoReply`, the path a visitor's message takes,
 * judged, checked mechanically, scored per language and written as a report.
 *
 * Mock mode replaces the model with the scripted faux provider and the
 * embeddings with the deterministic fake, so the same code runs in CI
 * without a network; live mode is the nightly run against a real provider.
 */

const MOCK_DIMS = 64;
const MOCK_EMBEDDING_MODEL = 'fake-embedding';
const EVAL_PRINCIPAL = 'ai-eval';

const MOCK_PROVIDER: AiProviderConfig = {
  id: 'fake',
  kind: 'openai-compatible',
  label: 'Faux provider',
  baseUrl: 'http://llm.example.com/v1',
  auth: { type: 'none' },
};

export interface PreparedEvaluation {
  readonly stack: EvalStack;
  readonly knowledge: EvalKnowledgeCounts;
  /** One pass over the set. Mock flaws script wrong answers on purpose. */
  run(options?: { readonly flaws?: MockFlaws }): Promise<EvalReport>;
  stop(): Promise<void>;
}

const liveProvider = (config: EvalConfig): AiProviderConfig => {
  const live = config.live;
  if (live === null) {
    throw new Error('live mode without a live configuration');
  }
  return {
    id: 'ai-eval',
    kind: live.providerKind,
    label: 'Evaluation provider',
    baseUrl: live.baseUrl ?? null,
    auth: live.apiKey === undefined ? { type: 'none' } : { type: 'apiKey', apiKey: live.apiKey },
  };
};

const configureModels = async (stack: EvalStack, config: EvalConfig): Promise<EvalModels> => {
  const { settings } = stack.runtime;
  const by = { updatedBy: EVAL_PRINCIPAL };
  const provider = config.mode === 'mock' ? MOCK_PROVIDER : liveProvider(config);
  const chat = config.mode === 'mock' ? 'fake-model' : (config.live?.model ?? '');
  const embeddings =
    config.mode === 'mock'
      ? {
          baseUrl: 'https://embeddings.example.com/v1',
          apiKey: undefined,
          model: MOCK_EMBEDDING_MODEL,
          dims: MOCK_DIMS,
        }
      : (config.live?.embeddings ?? { baseUrl: '', apiKey: undefined, model: '', dims: 0 });

  await settings.set('ai.providers', [provider], by);
  await settings.set('ai.defaultProvider', provider.id, by);
  await settings.set('ai.defaultModel', chat, by);
  await settings.set('embedding.provider', provider.id, by);
  await settings.set('embedding.baseUrl', embeddings.baseUrl, by);
  await settings.set('embedding.apiKey', embeddings.apiKey ?? '', by);
  await settings.set('embedding.model', embeddings.model, by);
  await settings.set('embedding.dims', embeddings.dims, by);
  await settings.set('embedding.pricePerMillionTokens', 0, by);

  return {
    provider: provider.id,
    chat,
    judge: config.mode === 'mock' ? chat : (config.live?.judgeModel ?? chat),
    embeddings: embeddings.model,
  };
};

const titleOf = (chunk: RetrievedChunk): string =>
  chunk.title === '' ? chunk.sourceName : chunk.title;

const unique = (values: readonly string[]): string[] => [...new Set(values)];

interface ItemDeps {
  readonly stack: EvalStack;
  readonly ai: Pick<Ai, 'complete'>;
  readonly judge: Pick<Ai, 'complete'>;
  readonly retriever: Retriever;
  readonly threshold: number;
}

const promptOfCall = async (stack: EvalStack, callId: string): Promise<string> =>
  withSystemJob(stack.runtime.db, stack.brandId, EVAL_PRINCIPAL, async (tx) => {
    const [row] = await tx
      .select({ prompt: aiCalls.prompt })
      .from(aiCalls)
      .where(eq(aiCalls.id, callId))
      .limit(1);
    return JSON.stringify(row?.prompt ?? null);
  });

const judgeAnswer = async (
  deps: ItemDeps,
  item: EvalItem,
  answer: string,
  chunks: readonly RetrievedChunk[],
): Promise<JudgeVerdict | null> => {
  const { text } = await deps.judge.complete({
    brandId: deps.stack.brandId,
    feature: JUDGE_FEATURE,
    instructions: judgeInstructions(),
    messages: [
      {
        role: 'user',
        text: judgePayload({
          question: item.question,
          locale: item.locale,
          sources: chunks.map((chunk) => ({
            index: chunk.index,
            title: titleOf(chunk),
            content: chunk.content,
          })),
          keyFacts: item.keyFacts,
          injected: item.attack?.kind === 'injection' ? item.attack.forbidden : [],
          answer,
        }),
      },
    ],
    temperature: 0,
    maxTokens: JUDGE_MAX_TOKENS,
  });
  return parseJudgeVerdict(text);
};

const evaluateItem = async (deps: ItemDeps, item: EvalItem): Promise<EvalItemResult> => {
  const base = {
    id: item.id,
    locale: item.locale,
    category: item.category,
    attackKind: item.attack?.kind ?? null,
    expectedSources: item.expectedSources,
  };
  const generated = await generateAutoReply(
    { ai: deps.ai, retriever: deps.retriever, log: silentJobLogger },
    {
      brandId: deps.stack.brandId,
      ticketId: null,
      text: item.question,
      locale: detectLocale(item.question),
      turns: [{ from: 'customer', text: item.question }],
      threshold: deps.threshold,
    },
  );
  if (generated === null) {
    return {
      ...base,
      outcome: 'error',
      handoffReason: null,
      confidence: null,
      answer: null,
      rawAnswer: null,
      citations: { total: 0, valid: 0 },
      citedSources: [],
      retrievedSources: [],
      judge: null,
      checks: { forbiddenInAnswer: false, secretsInPrompt: false },
      error: 'no model answered: budget spent or no model configured',
      callId: null,
    };
  }

  const { outcome, chunks, rawAnswer, callId } = generated;
  const check =
    rawAnswer === null ? null : validateCitations(readSelfAssessment(rawAnswer).text, chunks);
  const answer = outcome.kind === 'answer' ? outcome.decision.text : null;
  const citedSources =
    outcome.kind === 'answer'
      ? unique(
          outcome.decision.citations.flatMap((citation) => {
            const chunk = chunks.find((candidate) => candidate.chunkId === citation.chunkId);
            return chunk === undefined ? [] : [titleOf(chunk)];
          }),
        )
      : [];
  const judge = answer === null ? null : await judgeAnswer(deps, item, answer, chunks);
  const forbidden = item.attack?.forbidden ?? [];
  const secrets = item.attack?.secrets ?? [];
  const prompt =
    callId === null || secrets.length === 0 ? '' : await promptOfCall(deps.stack, callId);

  return {
    ...base,
    outcome: outcome.kind,
    handoffReason: outcome.kind === 'handoff' ? outcome.reason : null,
    confidence: outcome.kind === 'answer' ? outcome.decision.confidence : outcome.confidence,
    answer,
    rawAnswer,
    citations:
      check === null
        ? { total: 0, valid: 0 }
        : { total: check.citations.length + check.dropped.length, valid: check.citations.length },
    citedSources,
    retrievedSources: unique(chunks.map(titleOf)),
    judge,
    checks: {
      forbiddenInAnswer: answer !== null && forbidden.some((text) => answer.includes(text)),
      secretsInPrompt: secrets.some((secret) => prompt.includes(secret)),
    },
    error: null,
    callId,
  };
};

const failedItem = (item: EvalItem, error: unknown): EvalItemResult => ({
  id: item.id,
  locale: item.locale,
  category: item.category,
  attackKind: item.attack?.kind ?? null,
  outcome: 'error',
  handoffReason: null,
  confidence: null,
  answer: null,
  rawAnswer: null,
  citations: { total: 0, valid: 0 },
  citedSources: [],
  expectedSources: item.expectedSources,
  retrievedSources: [],
  judge: null,
  checks: { forbiddenInAnswer: false, secretsInPrompt: false },
  error: error instanceof Error ? error.message : String(error),
  callId: null,
});

/** `fn` over every item, at most `limit` at a time, results in the items' order. */
export const mapConcurrently = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export const writeEvalReport = async (dir: string, report: EvalReport): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, 'report.md'), renderEvalMarkdown(report));
};

export interface PrepareOptions {
  readonly config: EvalConfig;
  readonly suite: EvalSuite;
  readonly now?: () => Date;
}

export const prepareEvaluation = async ({
  config,
  suite,
  now = () => new Date(),
}: PrepareOptions): Promise<PreparedEvaluation> => {
  const http: HttpTransport =
    config.mode === 'mock'
      ? fakeEmbeddingsServer(MOCK_DIMS, [MOCK_EMBEDDING_MODEL], bagOfWordsVector).http
      : safeAiTransport([]);
  const stack = await startEvalStack({
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    http,
  });
  try {
    const models = await configureModels(stack, config);
    const embedder = createAiRuntime({
      db: stack.runtime.db,
      settings: stack.runtime.settings,
      http,
    });
    const knowledge = await loadEvalKnowledge({ stack, fixture: suite.fixture, ai: embedder });
    const retriever = createRetriever({
      db: stack.runtime.db,
      embedQuery: createQueryEmbedder(stack.runtime.db, embedder),
    });

    const run = async ({
      flaws = {},
    }: {
      readonly flaws?: MockFlaws;
    } = {}): Promise<EvalReport> => {
      const mock = config.mode === 'mock' ? createMockEvalModel(suite.items, flaws) : null;
      const transport: ModelTransport | undefined = mock?.transport;
      try {
        const ai = createAiRuntime({
          db: stack.runtime.db,
          settings: stack.runtime.settings,
          http,
          ...(transport === undefined ? {} : { transport }),
        });
        const judge = createAi({
          ports: new InMemoryAiPorts({
            provider: config.mode === 'mock' ? MOCK_PROVIDER : liveProvider(config),
            modelId: models.judge,
          }),
          http,
          ...(transport === undefined ? {} : { transport }),
        });
        const deps: ItemDeps = { stack, ai, judge, retriever, threshold: config.threshold };
        const results = await mapConcurrently(suite.items, config.concurrency, (item) =>
          evaluateItem(deps, item).catch((error: unknown) => failedItem(item, error)),
        );
        const score = scoreResults(results);
        const report: EvalReport = {
          generatedAt: now().toISOString(),
          mode: config.mode,
          models,
          threshold: config.threshold,
          thresholds: DOMAIN_RULES_9,
          knowledge,
          score,
          results,
          passed: score.passed,
        };
        await writeEvalReport(config.reportDir, report);
        return report;
      } finally {
        mock?.unregister();
      }
    };

    return { stack, knowledge, run, stop: () => stack.stop() };
  } catch (error) {
    await stack.stop();
    throw error;
  }
};
