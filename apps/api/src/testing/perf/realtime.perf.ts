import { writeFile } from 'node:fs/promises';
import { uuidv7 } from '@helpdock/db';
import {
  SOCKET_IO_PATH,
  WIDGET_EVENTS,
  WIDGET_NAMESPACE,
  type WidgetEnvelope,
  type WidgetMessage,
  type WidgetSession,
  type WidgetStartResponse,
} from '@helpdock/schemas';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_RULES_14, type PerfDataset, scaleDataset, seedPerfDataset } from './dataset.js';
import { envNumber, hasDocker, type PerfStack, signIn, startPerfStack } from './stack.js';
import { summarise } from './stats.js';

/**
 * The M9-03 realtime gate: "Realtime delivery, agent reply to widget < 500 ms
 * end-to-end" (PRD §2), measured as DOMAIN-RULES §14 says: "agent reply submit
 * → widget render, same host, no throttling".
 *
 *   pnpm --filter @helpdock/api build
 *   pnpm --filter @helpdock/api perf:realtime
 *
 * It seeds the §14 dataset, starts the api replicas **and a worker** — a reply
 * reaches a visitor through the outbox, the worker and Redis pub/sub, so a
 * stack without one measures nothing — and opens `PERF_WIDGET_SESSIONS`
 * visitors, each with a conversation and a `/widget` socket spread across the
 * replicas. While every visitor sends one message a minute (§14's widget load),
 * `PERF_AGENTS` agent loops reply to the conversations in turn. A sample is the
 * time from just before the reply's `POST` to the moment the visitor's socket
 * receives that message's `message` event. A reply that never arrives is an
 * error, and any error fails the run.
 *
 * Environment (all optional): `PERF_WIDGET_SESSIONS` (200), `PERF_AGENTS` (5),
 * `PERF_REPLY_THINK_MS` (5000: five agents, about one reply a second), `PERF_WARMUP_S` (120), `PERF_DURATION_S` (600),
 * `PERF_REPLICAS` (2), `PERF_REALTIME_P95_MS` (500), `PERF_SCALE` (1),
 * `PERF_REPORT` (a JSON path).
 */

const settings = {
  sessions: Math.max(1, envNumber('PERF_WIDGET_SESSIONS', 200)),
  agents: Math.max(1, envNumber('PERF_AGENTS', 5)),
  replyThinkMs: envNumber('PERF_REPLY_THINK_MS', 5000),
  warmupMs: envNumber('PERF_WARMUP_S', 120) * 1000,
  durationMs: envNumber('PERF_DURATION_S', 600) * 1000,
  replicas: Math.max(1, envNumber('PERF_REPLICAS', 2)),
  gateMs: envNumber('PERF_REALTIME_P95_MS', 500),
  scale: envNumber('PERF_SCALE', 1),
};

/** The site the widget is embedded on; the brand allows it. */
const ORIGIN = 'https://shop.perf.test';
const VISITOR_MESSAGE_EVERY_MS = 60_000;
/** How long a reply may still arrive after the run stops before it counts as lost. */
const GRACE_MS = 5_000;
const TOKEN_REFRESH_MS = 4 * 60_000;

interface Visitor {
  readonly secret: string;
  readonly conversationId: string;
  readonly socket: Socket;
}

describe.skipIf(!hasDocker)('realtime delivery, agent reply to widget (M9-03, §14)', () => {
  let stack: PerfStack;
  let dataset: PerfDataset;
  const visitors: Visitor[] = [];

  beforeAll(async () => {
    stack = await startPerfStack({
      replicas: settings.replicas,
      worker: true,
      // Every visitor here is one load generator. With the proxy trusted, each
      // gets an address of its own from `x-forwarded-for`, as two hundred
      // browsers would, instead of all sharing the per-address budgets.
      env: { TRUST_PROXY: 'true' },
      seed: async (app, passwordHash) => {
        dataset = await seedPerfDataset(app.db, {
          measured: scaleDataset(DOMAIN_RULES_14.measured, settings.scale),
          others: scaleDataset(DOMAIN_RULES_14.others, settings.scale),
          passwordHash,
          log: (message) => process.stdout.write(`${message}\n`),
        });
      },
    });
  }, 1_800_000);

  afterAll(async () => {
    for (const visitor of visitors) {
      visitor.socket.disconnect();
    }
    await stack?.stop();
  });

  it(
    'delivers an agent reply to the widget under the p95 gate',
    async () => {
      const { baseUrls } = stack;
      const [firstUrl] = baseUrls as [string];
      const agent = { token: await signIn(firstUrl, dataset.admin.email) };
      const refresh = setInterval(() => {
        void signIn(firstUrl, dataset.admin.email).then((token) => {
          agent.token = token;
        });
      }, TOKEN_REFRESH_MS);

      await allowOrigin(firstUrl, dataset.brandId, agent.token);

      const arrivals = new Map<string, number>();
      for (let index = 0; index < settings.sessions; index += 10) {
        const batch = Array.from(
          { length: Math.min(10, settings.sessions - index) },
          (_, offset) => index + offset,
        );
        visitors.push(
          ...(await Promise.all(
            batch.map((n) =>
              openVisitor(baseUrls[n % baseUrls.length] as string, dataset.brandId, n, arrivals),
            ),
          )),
        );
      }

      const started = performance.now();
      const measureFrom = started + settings.warmupMs;
      const stopAt = measureFrom + settings.durationMs;
      const remainingMs = () => stopAt - performance.now();

      const background = visitors.map((visitor, index) =>
        visitorChatter(visitor, (index / visitors.length) * VISITOR_MESSAGE_EVERY_MS, remainingMs),
      );

      const sent = new Map<string, number>();
      let next = 0;
      const agentLoop = async (loop: number): Promise<void> => {
        const baseUrl = baseUrls[loop % baseUrls.length] as string;
        while (remainingMs() > 0) {
          const visitor = visitors[next % visitors.length] as Visitor;
          next += 1;
          const before = performance.now();
          const id = await reply(baseUrl, dataset.brandId, visitor.conversationId, agent.token);
          if (before >= measureFrom) {
            sent.set(id, before);
          }
          await new Promise((resolve) => setTimeout(resolve, settings.replyThinkMs));
        }
      };

      try {
        await Promise.all([
          ...Array.from({ length: settings.agents }, (_, loop) => agentLoop(loop)),
          ...background,
        ]);
        await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
      } finally {
        clearInterval(refresh);
      }

      const latencies: number[] = [];
      let lost = 0;
      for (const [id, at] of sent) {
        const arrived = arrivals.get(id);
        if (arrived === undefined) {
          lost += 1;
        } else {
          latencies.push(arrived - at);
        }
      }
      const summary = summarise(latencies);

      process.stdout.write(
        [
          '',
          `Settings: ${JSON.stringify(settings)}`,
          `Replies measured: ${summary.count}; lost: ${lost}`,
          `Agent reply → widget: p50 ${summary.p50.toFixed(1)} ms, p95 ${summary.p95.toFixed(1)} ms, p99 ${summary.p99.toFixed(1)} ms, max ${summary.max.toFixed(1)} ms`,
          '',
        ].join('\n'),
      );
      if (process.env.PERF_REPORT !== undefined && process.env.PERF_REPORT !== '') {
        await writeFile(
          process.env.PERF_REPORT,
          JSON.stringify({ settings, summary, lost }, null, 2),
        );
      }

      expect(summary.count).toBeGreaterThan(0);
      expect(lost).toBe(0);
      expect(summary.p95).toBeLessThanOrEqual(settings.gateMs);
    },
    settings.warmupMs + settings.durationMs + 600_000,
  );
});

const json = async <T>(response: Response, what: string): Promise<T> => {
  if (!response.ok) {
    throw new Error(`${what} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
};

const allowOrigin = async (baseUrl: string, brandId: string, token: string): Promise<void> => {
  await json(
    await fetch(`${baseUrl}/api/brands/${brandId}/widget/access`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        allowedOrigins: [ORIGIN],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '',
      }),
    }),
    'widget access',
  );
};

/** A documentation address per visitor (RFC 5737's TEST-NET-3 has 254; past that, 10/8). */
const addressOf = (n: number): string =>
  n < 254 ? `203.0.113.${n + 1}` : `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

const openVisitor = async (
  baseUrl: string,
  brandId: string,
  n: number,
  arrivals: Map<string, number>,
): Promise<Visitor> => {
  const widget = `${baseUrl}/api/widget/${brandId}`;
  const headers = {
    origin: ORIGIN,
    'content-type': 'application/json',
    'x-forwarded-for': addressOf(n),
  };
  const session = await json<WidgetSession>(
    await fetch(`${widget}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ locale: 'en' }),
    }),
    'widget session',
  );
  const secret = session.visitorSecret ?? '';
  const started = await json<WidgetStartResponse>(
    await fetch(`${widget}/conversations`, {
      method: 'POST',
      headers: { ...headers, authorization: `Visitor ${secret}` },
      body: JSON.stringify({ clientId: uuidv7(), text: `Visitor ${n} needs help` }),
    }),
    'widget start',
  );
  const conversationId = started.conversation.id;

  const socket = io(`${baseUrl}${WIDGET_NAMESPACE}`, {
    path: SOCKET_IO_PATH,
    transports: ['websocket'],
    auth: { brandId, visitorSecret: secret },
    extraHeaders: { origin: ORIGIN },
  });
  socket.on(WIDGET_EVENTS.message, (envelope: WidgetEnvelope<WidgetMessage>) => {
    if (envelope.data.author === 'agent' && !arrivals.has(envelope.data.id)) {
      arrivals.set(envelope.data.id, performance.now());
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const joined = (await socket.emitWithAck(WIDGET_EVENTS.join, { conversationId })) as {
    ok: boolean;
  };
  if (!joined.ok) {
    throw new Error(`visitor ${n} could not join their conversation`);
  }

  return { secret, conversationId, socket };
};

/** One message a minute, from a different point in the minute for each visitor. */
const visitorChatter = async (
  visitor: Visitor,
  offsetMs: number,
  remainingMs: () => number,
): Promise<void> => {
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, remainingMs()))));
  await pause(offsetMs);
  while (remainingMs() > 0) {
    await visitor.socket.emitWithAck(WIDGET_EVENTS.send, {
      conversationId: visitor.conversationId,
      message: { clientId: uuidv7(), text: 'Any news?', attachmentIds: [] },
    });
    await pause(VISITOR_MESSAGE_EVERY_MS);
  }
};

const reply = async (
  baseUrl: string,
  brandId: string,
  ticketId: string,
  token: string,
): Promise<string> => {
  const message = await json<{ id: string }>(
    await fetch(`${baseUrl}/api/brands/${brandId}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'public',
        bodyHtml: '<p>We are on it.</p>',
        clientId: uuidv7(),
      }),
    }),
    'agent reply',
  );
  return message.id;
};
