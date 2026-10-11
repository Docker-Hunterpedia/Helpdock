import {
  GRAPH_IDENTITY_FIELDS,
  GraphApiFailure,
  graphIdentityName,
  graphIdentitySchema,
  graphSubscribedAppsSchema,
  parseGraph,
  redactToken,
  subscribedAppsOf,
} from '@helpdock/channels';
import { decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import {
  auditLog,
  type Db,
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  type NewMetaAccount,
} from '@helpdock/db';
import {
  META_ERROR_MAX_LENGTH,
  META_SUBSCRIBED_FIELDS,
  META_TOKEN_KIND,
  type MetaAccount,
  type MetaAccountCreateRequest,
  type MetaAccountList,
  type MetaAccountStatusResponse,
  type MetaAccountUpdateRequest,
  type MetaPlatform,
  type MetaRefusal,
  type MetaSubscribeResult,
  type MetaTestResult,
  type MetaTokenTestRequest,
  metaAccountHealth,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import {
  type AccountGraph,
  type GraphClientFactory,
  graphForAccount,
  graphForToken,
} from './graph-factory.js';
import type { AccountWithNames, MetaRepository } from './meta.repository.js';
import { toMetaAccount } from './meta-account-view.js';
import { enqueueMetaAccountChanged } from './meta-events.js';
import { MetaFailure } from './meta-failure.js';
import { refreshInstagramToken } from './meta-token-refresh.js';
import { readTokenFacts } from './token-facts.js';
import { identifyWhatsApp } from './whatsapp-identity.js';

/**
 * Channels › Meta (M10-07): connecting, editing, testing and disconnecting the
 * WhatsApp numbers, Facebook Pages and Instagram accounts of a brand, and the
 * status panel of each.
 *
 * The rules this module keeps are `TelegramBotsService`'s, adapted to Graph:
 *
 * - **A secret goes in and never comes out.** The token is encrypted under
 *   `APP_MASTER_KEY`; a read says that one is set and shows its last four
 *   characters. It is decrypted only inside {@link graphForAccount}, which
 *   hands out calls rather than the token.
 * - **A token is checked before it is stored**, by reading the account it is
 *   meant for. That says which account it is (the name the list shows), refuses
 *   a token for another account or product, and is what "Test" runs.
 * - **An account answers for one brand.** `(platform, external id)` is unique
 *   across the install, so the id is looked up across brands before Graph is
 *   asked anything.
 * - **Connecting subscribes the app** to the account's webhook fields, because
 *   a connected account that Meta does not post for is a silent one.
 * - **Every change is audited**, without the token, and a change to an account
 *   is announced on the outbox so the health job follows it.
 *
 * "Test", "Subscribe now" and the status panel talk to Graph from the request,
 * as "Test connection" does for Telegram: they are what the button is for, the
 * answer is shown at once, and none of them reaches a customer.
 */

export type MetaAuditAction =
  | 'meta_account.created'
  | 'meta_account.updated'
  | 'meta_account.deleted'
  | 'meta_account.subscribed'
  | 'meta_account.refreshed';

/** "Failed sends, 24 h" on the Activity card. */
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * An Instagram user token the dashboard hands out is a long-lived one: 60 days.
 * Instagram's `GET /me` does not say when it ends, so this is the expiry
 * Helpdock records until the first renewal says a real one.
 */
const INSTAGRAM_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1_000;

/** Instagram answers `/me` with its own app-scoped `id` and, beside it, the account's `user_id`. */
const instagramMeSchema = graphIdentitySchema.extend({
  user_id: z
    .union([z.string().min(1), z.number().int()])
    .transform(String)
    .optional(),
});

/**
 * What an operator is told when a WhatsApp number has no business account on
 * record, which a connection made by this version cannot produce: Meta keeps the
 * subscription on the business account, so there is nowhere to ask.
 */
const RECONNECT_DETAIL =
  'This number has no WhatsApp business account on record. Disconnect it and connect it again so Helpdock can find it.';

/** What Graph said an account is, in the shape the account row and the Test box share. */
interface Identified {
  readonly name: string;
  /** Instagram: the `@handle`; Messenger: the Page's name. */
  readonly username: string | null;
  readonly displayPhone: string | null;
  /** Null for a token that does not expire. */
  readonly expiresAt: Date | null;
  /** WhatsApp: the business account that owns the number, which Meta subscribes the app on. */
  readonly wabaId: string | null;
}

/** How a refused identification reads, to a screen and to a log. */
interface Refused {
  readonly refusal: MetaRefusal;
  /** What the Test box calls it: Graph refused the token, refused the read, or was not reached. */
  readonly kind: 'token' | 'refused' | 'connect';
  readonly detail: string | null;
}

type Identity = ({ readonly ok: true } & Identified) | ({ readonly ok: false } & Refused);

const clip = (text: string): string => text.slice(0, META_ERROR_MAX_LENGTH);

export class MetaAccountsService {
  readonly #db: Db;
  readonly #repository: MetaRepository;
  readonly #keyring: Keyring;
  readonly #graph: GraphClientFactory;
  readonly #app: { secrets(): Promise<string[]> };
  readonly #now: () => Date;

  constructor(options: {
    readonly db: Db;
    readonly repository: MetaRepository;
    readonly keyring: Keyring;
    readonly graph: GraphClientFactory;
    readonly app: { secrets(): Promise<string[]> };
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#keyring = options.keyring;
    this.#graph = options.graph;
    this.#app = options.app;
    this.#now = options.now ?? (() => new Date());
  }

  async list(tx: DbTransaction): Promise<MetaAccountList> {
    return { accounts: (await this.#repository.list(tx)).map((row) => this.#toView(row)) };
  }

  async get(tx: DbTransaction, id: string): Promise<MetaAccount> {
    return this.#toView(await this.#require(tx, id));
  }

  /**
   * "Connect": the token is read against the id (which also says what the
   * account is called), the app is subscribed to the account's fields, and the
   * row is stored. A subscription Meta refuses for good — a token that cannot
   * subscribe an app will not receive anything — refuses the connection; one
   * that failed for a moment is recorded on the row and the hourly health check
   * tries again.
   */
  async create(context: TicketingContext, request: MetaAccountCreateRequest): Promise<MetaAccount> {
    const { tx, brandId, actor } = context;
    const { platform, externalId } = request;
    await this.#requireApp();
    await this.#requireDepartment(tx, request.departmentId);
    await this.#requireFree(platform, externalId);

    const graph = graphForToken(platform, request.accessToken, this.#graph);
    const identified = this.#unwrap(await this.#identify(graph, externalId));
    const subscription = await this.#subscribe(
      graph,
      platform,
      subscriptionNodeOf(platform, externalId, identified.wabaId),
    );
    if (!subscription.ok && subscription.failure.permanent) {
      throw new MetaFailure('subscribe-failed');
    }

    const now = this.#now();
    const row = await this.#repository.insert(tx, {
      brandId,
      platform,
      departmentId: request.departmentId,
      externalId,
      wabaId: identified.wabaId,
      displayPhone: identified.displayPhone,
      username: identified.username,
      displayName: request.displayName ?? identified.name,
      accessToken: encryptSecret(request.accessToken, this.#keyring),
      tokenKind: META_TOKEN_KIND[platform],
      tokenExpiresAt: identified.expiresAt,
      tokenRefreshedAt: platform === 'instagram' ? now : null,
      tokenUpdatedAt: now,
      tokenUpdatedBy: actor.userId,
      humanAgentEnabled: platform !== 'whatsapp' && request.humanAgentEnabled,
      ...(subscription.ok
        ? {
            subscribedFields: [...subscription.fields],
            subscribedAt: now,
            subscriptionCheckedAt: now,
            status: 'connected' as const,
          }
        : {
            status: 'unsubscribed' as const,
            lastError: clip(redactToken(subscription.failure.detail, request.accessToken)),
            lastErrorAt: now,
          }),
    });
    if (row === undefined) {
      throw new MetaFailure('account-taken');
    }

    await this.#changed(context, 'meta_account.created', row.id, { platform, externalId });
    return this.get(tx, row.id);
  }

  /**
   * "Save account": the routing and the Human Agent switch, and a new token
   * when Replace was pressed. A new token must open the same account — a
   * revoked token is replaced, a different account is a different row — and
   * brings the account back to `connected` with a subscription made again.
   */
  async update(
    context: TicketingContext,
    id: string,
    request: MetaAccountUpdateRequest,
  ): Promise<MetaAccount> {
    const { tx, actor } = context;
    const { account: current } = await this.#require(tx, id);
    await this.#requireDepartment(tx, request.departmentId);

    const humanAgentEnabled = current.platform !== 'whatsapp' && request.humanAgentEnabled;
    const values: Partial<NewMetaAccount> = {
      displayName: request.displayName,
      departmentId: request.departmentId,
      humanAgentEnabled,
    };

    if (request.accessToken !== undefined) {
      const graph = graphForToken(current.platform, request.accessToken, this.#graph);
      const identified = this.#unwrap(await this.#identify(graph, current.externalId));
      const subscription = await this.#subscribe(
        graph,
        current.platform,
        subscriptionNodeOf(current.platform, current.externalId, identified.wabaId),
      );
      if (!subscription.ok && subscription.failure.permanent) {
        throw new MetaFailure('subscribe-failed');
      }
      const now = this.#now();
      Object.assign(values, {
        // A new token finds the business account again, which also repairs a row made without one.
        wabaId: identified.wabaId ?? current.wabaId,
        username: identified.username ?? current.username,
        displayPhone: identified.displayPhone ?? current.displayPhone,
        accessToken: encryptSecret(request.accessToken, this.#keyring),
        tokenExpiresAt: identified.expiresAt,
        tokenRefreshedAt: current.platform === 'instagram' ? now : current.tokenRefreshedAt,
        tokenUpdatedAt: now,
        tokenUpdatedBy: actor.userId,
        ...(subscription.ok
          ? {
              subscribedFields: [...subscription.fields],
              subscribedAt: now,
              subscriptionCheckedAt: now,
              status: 'connected' as const,
              lastError: null,
              lastErrorAt: null,
            }
          : {
              status: 'unsubscribed' as const,
              lastError: clip(redactToken(subscription.failure.detail, request.accessToken)),
              lastErrorAt: now,
            }),
      });
    }

    await this.#repository.update(tx, id, values);
    await this.#changed(context, 'meta_account.updated', id, {
      tokenReplaced: request.accessToken !== undefined,
      departmentChanged: request.departmentId !== current.departmentId,
      // Meta may restrict a Page that uses the tag without approval, so the audit trail says who said so.
      ...(humanAgentEnabled === current.humanAgentEnabled ? {} : { humanAgentEnabled }),
    });
    return this.get(tx, id);
  }

  /**
   * The row, its conversations and its deliveries go; tickets and contacts
   * stay. The app is unsubscribed from the account first, as far as Graph lets
   * it be: a revoked token or an unreachable Graph must not keep an account the
   * Admin is disconnecting.
   */
  async remove(context: TicketingContext, id: string): Promise<void> {
    const { account } = await this.#require(context.tx, id);
    const node = subscriptionNodeOf(account.platform, account.externalId, account.wabaId);
    if (node !== null) {
      await graphForAccount(account, this.#keyring, this.#graph)
        .delete(`/${node}/subscribed_apps`)
        .catch(() => undefined);
    }
    const removed = await this.#repository.delete(context.tx, id);
    if (removed === undefined) {
      throw new NotFoundException('No such Meta account');
    }
    await this.#changed(context, 'meta_account.deleted', id, {
      platform: removed.platform,
      externalId: removed.externalId,
    });
  }

  /** "Test connection": reads the account with the stored token. Writes nothing. */
  async test(tx: DbTransaction, id: string): Promise<MetaTestResult> {
    const { account } = await this.#require(tx, id);
    const graph = graphForAccount(account, this.#keyring, this.#graph);
    const identity = await this.#identify(graph, account.externalId);

    return identity.ok
      ? this.#testResult(account.platform, account.externalId, identity, account.tokenExpiresAt)
      : { ok: false, kind: identity.kind, detail: identity.detail };
  }

  /**
   * "Test" in the Connect dialog: the same read with a typed token, before
   * anything is stored. Refuses what a rule refuses (the app is not set up, the
   * account is taken, the token is for another account or product) and answers
   * what Graph said of the token. Never repeats the token.
   */
  async testToken(request: MetaTokenTestRequest): Promise<MetaTestResult> {
    const { platform, externalId, accessToken } = request;
    await this.#requireApp();
    await this.#requireFree(platform, externalId);

    const identity = await this.#identify(
      graphForToken(platform, accessToken, this.#graph),
      externalId,
    );
    if (identity.ok) {
      return this.#testResult(platform, externalId, identity, identity.expiresAt);
    }
    if (identity.refusal === 'token-other-account' || identity.refusal === 'platform-mismatch') {
      throw new MetaFailure(identity.refusal);
    }

    return { ok: false, kind: identity.kind, detail: identity.detail };
  }

  /**
   * "Subscribe now": subscribes the app to the account's fields again and
   * records what was subscribed. Graph's refusal is answered, and kept on the
   * row, so the panel can show it; a token Graph calls dead also marks the
   * account `token_expired`.
   */
  async subscribe(context: TicketingContext, id: string): Promise<MetaSubscribeResult> {
    const { tx } = context;
    const { account } = await this.#require(tx, id);
    const graph = graphForAccount(account, this.#keyring, this.#graph);
    const node = subscriptionNodeOf(account.platform, account.externalId, account.wabaId);
    const now = this.#now();
    if (node === null) {
      await this.#repository.markError(tx, id, RECONNECT_DETAIL, now);
      return { ok: false, detail: RECONNECT_DETAIL };
    }
    const outcome = await this.#subscribe(graph, account.platform, node);

    if (!outcome.ok) {
      await this.#repository.markError(tx, id, redactToken(outcome.failure.detail), now);
      if (outcome.failure.kind === 'token_dead') {
        await this.#repository.update(tx, id, { status: 'token_expired' });
      }
      return { ok: false, detail: clip(redactToken(outcome.failure.detail)) };
    }

    await this.#repository.update(tx, id, {
      subscribedFields: [...outcome.fields],
      subscribedAt: now,
      subscriptionCheckedAt: now,
      // Graph just accepted the token, so a state it was kept in for want of one is over.
      ...(account.status === 'connected'
        ? {}
        : { status: 'connected' as const, lastError: null, lastErrorAt: null }),
    });
    await this.#audit(context, 'meta_account.subscribed', id, { fields: outcome.fields });
    return {
      ok: true,
      subscribedFields: [...outcome.fields],
      subscribedAt: now.toISOString(),
    };
  }

  /**
   * The status panel: the row's facts and what Graph says now — whether the
   * token is valid and which apps are subscribed — and the Activity card. A
   * question Graph could not answer is `null` with the reason in `liveError`,
   * never a failure of the route.
   */
  async status(tx: DbTransaction, id: string): Promise<MetaAccountStatusResponse> {
    const { account } = await this.#require(tx, id);
    const facts = await this.#repository.activity(
      tx,
      id,
      new Date(this.#now().getTime() - ACTIVITY_WINDOW_MS),
    );
    const live = await this.#live(graphForAccount(account, this.#keyring, this.#graph), account);

    return {
      status: account.status,
      health: metaAccountHealth(account),
      lastEventAt: account.lastEventAt?.toISOString() ?? null,
      lastError: account.lastError,
      lastErrorAt: account.lastErrorAt?.toISOString() ?? null,
      tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
      subscribedFields: account.subscribedFields,
      subscribedAt: account.subscribedAt?.toISOString() ?? null,
      subscriptionCheckedAt: account.subscriptionCheckedAt?.toISOString() ?? null,
      ...live,
      activity: {
        lastReplyAt: facts.lastReplyAt?.toISOString() ?? null,
        failedSends: facts.failedSends,
        refusedSends: facts.refusedSends,
        openTickets: facts.openTickets,
      },
    };
  }

  /**
   * "Renew now" for an Instagram token: {@link refreshInstagramToken}, which the
   * health job runs too. A token younger than a week is left as it is; Graph's
   * refusal is a `token-invalid` and stays on the row. Only Instagram tokens
   * expire.
   */
  async refresh(context: TicketingContext, id: string): Promise<MetaAccount> {
    const { tx } = context;
    const { account } = await this.#require(tx, id);
    if (account.platform !== 'instagram') {
      throw new BadRequestException('Only an Instagram token is renewed');
    }

    let result: Awaited<ReturnType<typeof refreshInstagramToken>>;
    try {
      result = await refreshInstagramToken(
        {
          db: this.#db,
          repository: this.#repository,
          keyring: this.#keyring,
          graph: this.#graph(),
          now: this.#now,
        },
        account,
      );
    } catch (error) {
      if (error instanceof GraphApiFailure) {
        throw new MetaFailure('graph-unreachable');
      }
      throw error;
    }
    if (result.outcome === 'refused') {
      throw new MetaFailure('token-invalid');
    }
    if (result.outcome === 'refreshed') {
      await this.#audit(context, 'meta_account.refreshed', id, {
        expiresAt: result.expiresAt?.toISOString() ?? null,
      });
    }

    return this.get(tx, id);
  }

  // ------------------------------------------------------------------

  /**
   * Reads the account a token is meant for, which says what it is called and
   * proves the token opens it. Instagram's `/me` is the token's own account, so
   * it is compared with the id typed; the others read the id and Graph refuses
   * a token that does not open it.
   */
  async #identify(graph: AccountGraph, externalId: string): Promise<Identity> {
    const { platform } = graph;
    try {
      if (platform === 'instagram') {
        const me = parseGraph(
          instagramMeSchema,
          await graph.get('/me', { fields: 'id,user_id,username,name' }),
          'to the account read',
        );
        if ((me.user_id ?? me.id) !== externalId) {
          return refused('token-other-account', 'refused', null);
        }
        return {
          ok: true,
          name: graphIdentityName(me),
          username: me.username ?? null,
          displayPhone: null,
          expiresAt: new Date(this.#now().getTime() + INSTAGRAM_TOKEN_LIFETIME_MS),
          wabaId: null,
        };
      }

      if (platform === 'whatsapp') {
        const number = await identifyWhatsApp(graph, externalId);
        if (!number.ok) {
          return refused(
            number.refusal,
            number.refusal === 'token-invalid' ? 'token' : 'refused',
            number.detail,
          );
        }
        return {
          ok: true,
          name: number.name,
          username: null,
          displayPhone: number.displayPhone,
          expiresAt: number.expiresAt,
          wabaId: number.wabaId,
        };
      }

      const identity = parseGraph(
        graphIdentitySchema,
        await graph.get(`/${externalId}`, { fields: GRAPH_IDENTITY_FIELDS[platform] }),
        'to the account read',
      );
      if (identity.id !== externalId) {
        return refused('token-other-account', 'refused', null);
      }
      const debug = await readTokenFacts(graph);
      if (debug.valid === false) {
        return refused('token-invalid', 'token', debug.detail);
      }

      return {
        ok: true,
        name: graphIdentityName(identity),
        // A Page's name goes where an Instagram handle does.
        username: identity.name ?? null,
        displayPhone: null,
        expiresAt: debug.expiresAt,
        wabaId: null,
      };
    } catch (error) {
      return this.#refusalOf(error, graph);
    }
  }

  /**
   * What a Graph failure means for a person pasting a token:
   *
   * | Graph said | The answer |
   * |---|---|
   * | the token is dead | `platform-mismatch` when it opens the other host, else `token-invalid` |
   * | the token is good but cannot read this id | `token-other-account` |
   * | it could not be reached, or answered nonsense | `graph-unreachable` |
   * | anything else (a restricted account) | `token-invalid`, in Graph's words |
   */
  async #refusalOf(error: unknown, graph: AccountGraph): Promise<Identity> {
    // A token with characters no header can carry is not one Meta issued.
    if (error instanceof TypeError) {
      return refused('token-invalid', 'token', null);
    }
    if (!(error instanceof GraphApiFailure)) {
      throw error;
    }
    const detail = clip(error.detail);
    if (
      error.kind === 'retry' ||
      error.kind === 'rate_limited' ||
      error.reason !== null ||
      (error.kind === 'permanent' && error.code === null)
    ) {
      return refused('graph-unreachable', 'connect', detail);
    }
    if (error.kind === 'token_dead') {
      // A product's token is dead to the other product's host, so one that is
      // alive there is a token for the other product, not a revoked one. The
      // shape of an id is nothing Meta promises; the host the token opens is.
      return (await this.#opensOtherHost(graph))
        ? refused('platform-mismatch', 'token', detail)
        : refused('token-invalid', 'token', detail);
    }
    if (error.kind === 'permission' || error.kind === 'permanent') {
      return refused('token-other-account', 'refused', detail);
    }
    return refused('token-invalid', 'refused', detail);
  }

  async #opensOtherHost(graph: AccountGraph): Promise<boolean> {
    try {
      await graph.onOtherHost().get('/me', { fields: 'id' });
      return true;
    } catch {
      return false;
    }
  }

  /** The refusal a failed identification is, or what it found. */
  #unwrap(identity: Identity): Identified {
    if (!identity.ok) {
      throw new MetaFailure(identity.refusal);
    }
    return identity;
  }

  #testResult(
    platform: MetaPlatform,
    externalId: string,
    identified: Identified,
    expiresAt: Date | null,
  ): MetaTestResult {
    return {
      ok: true,
      platform,
      externalId,
      name: identified.name,
      ...(platform === 'instagram' && identified.username !== null
        ? { username: identified.username }
        : {}),
      ...(expiresAt === null ? {} : { tokenExpiresAt: expiresAt.toISOString() }),
    };
  }

  /**
   * `POST /{node}/subscribed_apps` for the platform's fields; Graph's refusal is
   * returned, not thrown. WhatsApp subscribes the whole `messages` field and takes
   * none by name.
   */
  async #subscribe(
    graph: AccountGraph,
    platform: MetaPlatform,
    node: string | null,
  ): Promise<
    | { readonly ok: true; readonly fields: readonly string[] }
    | { readonly ok: false; readonly failure: GraphApiFailure }
  > {
    const fields = META_SUBSCRIBED_FIELDS[platform];
    if (node === null) {
      return { ok: false, failure: new GraphApiFailure('permanent', RECONNECT_DETAIL) };
    }
    try {
      const answer = await graph.post(
        `/${node}/subscribed_apps`,
        platform === 'whatsapp' ? {} : { query: { subscribed_fields: fields.join(',') } },
      );
      if ((answer as { readonly success?: unknown } | null)?.success === false) {
        throw new GraphApiFailure('permanent', 'Graph did not accept the subscription');
      }
      return { ok: true, fields };
    } catch (error) {
      if (error instanceof GraphApiFailure) {
        return { ok: false, failure: error };
      }
      throw error;
    }
  }

  /** What Graph says now, for the status panel. */
  async #live(
    graph: AccountGraph,
    account: MetaAccountRow,
  ): Promise<Pick<MetaAccountStatusResponse, 'tokenValid' | 'subscribedApps' | 'liveError'>> {
    // Established as the calls go: a token that read the account is a token that works.
    let tokenValid: boolean | null = null;
    try {
      if (account.platform === 'instagram') {
        // Instagram's host has no `debug_token`; reading the account is the check.
        await graph.get('/me', { fields: 'id' });
        tokenValid = true;
      } else {
        const debug = await readTokenFacts(graph);
        if (debug.valid === false) {
          return { tokenValid: false, subscribedApps: null, liveError: debug.detail };
        }
        tokenValid = debug.valid;
      }
      const node = subscriptionNodeOf(account.platform, account.externalId, account.wabaId);
      if (node === null) {
        return { tokenValid, subscribedApps: null, liveError: RECONNECT_DETAIL };
      }
      const apps = subscribedAppsOf(
        parseGraph(
          graphSubscribedAppsSchema,
          await graph.get(`/${node}/subscribed_apps`),
          'to the subscribed apps',
        ),
      );

      return {
        tokenValid: true,
        subscribedApps: apps.map((app) => ({
          id: app.id,
          name: app.name,
          subscribedFields: [...app.subscribedFields],
        })),
        liveError: null,
      };
    } catch (error) {
      if (!(error instanceof GraphApiFailure)) {
        throw error;
      }
      return {
        tokenValid: error.kind === 'token_dead' ? false : tokenValid,
        subscribedApps: null,
        liveError: clip(error.detail),
      };
    }
  }

  #toView(row: AccountWithNames): MetaAccount {
    return toMetaAccount(row, decryptSecret(row.account.accessToken, this.#keyring));
  }

  async #require(tx: DbTransaction, id: string): Promise<AccountWithNames> {
    const found = await this.#repository.find(tx, id);
    if (found === undefined) {
      throw new NotFoundException('No such Meta account');
    }
    return found;
  }

  async #requireDepartment(tx: DbTransaction, departmentId: string): Promise<void> {
    if (!(await this.#repository.departmentExists(tx, departmentId))) {
      throw new MetaFailure('department-not-found');
    }
  }

  /** With no app secret no webhook would verify, so there is nothing to connect an account to. */
  async #requireApp(): Promise<void> {
    if ((await this.#app.secrets()).length === 0) {
      throw new MetaFailure('app-not-configured');
    }
  }

  /**
   * The account must not be connected already, in this brand or another. The
   * read crosses brands, which `INSERT … ON CONFLICT` also does without saying
   * so; asking first lets "Test" refuse it before anything is sent to Graph.
   */
  async #requireFree(platform: MetaPlatform, externalId: string): Promise<void> {
    if ((await this.#repository.locate(this.#db, platform, externalId)) !== undefined) {
      throw new MetaFailure('account-taken');
    }
  }

  async #changed(
    context: TicketingContext,
    action: MetaAuditAction,
    accountId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.#audit(context, action, accountId, meta);
    await enqueueMetaAccountChanged(context.tx, context.brandId, accountId);
  }

  async #audit(
    { tx, brandId, actor }: TicketingContext,
    action: MetaAuditAction,
    accountId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: 'meta_account',
      targetId: accountId,
      meta,
    });
  }
}

const refused = (refusal: MetaRefusal, kind: Refused['kind'], detail: string | null): Identity => ({
  ok: false,
  refusal,
  kind,
  detail,
});

/**
 * Where Meta keeps the app's webhook subscription: on the business account for a
 * WhatsApp number, whose own node has no such edge, and on the account itself for
 * a Page or an Instagram account. Null for a number whose business account was
 * never recorded.
 */
const subscriptionNodeOf = (
  platform: MetaPlatform,
  externalId: string,
  wabaId: string | null,
): string | null => (platform === 'whatsapp' ? wabaId : externalId);
