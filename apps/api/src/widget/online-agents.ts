import type { Db, DbTransaction } from '@helpdock/db';
import {
  type PresenceMap,
  WIDGET_ONLINE_AGENTS_MAX,
  type WidgetOnlineAgent,
  type WidgetPresence,
} from '@helpdock/schemas';
import { withSystemJob } from '../tenant/system-job.js';
import type { AgentCards } from './agent-cards.js';
import { type ResolvedWidgetSettings, resolveWidgetSettings } from './resolved-settings.js';
import type { WidgetRepository } from './widget.repository.js';
import type { WidgetSettingsRepository } from './widget-settings.repository.js';

export interface PresenceReader {
  mapOf(brandId: string): Promise<PresenceMap>;
}

/**
 * "Lina, Karim and Sara are online now" (M4-08): who of the brand is online,
 * as a visitor may see them — public names (M14-12) and photos, sorted so the
 * line does not shuffle between frames, and nothing at all when the brand
 * turned off "Show the agent's name and photo". Someone with no photo has a
 * null `avatarUrl` and the widget draws initials.
 */
export class OnlineAgents {
  readonly #db: Db;
  readonly #presence: PresenceReader;
  readonly #settings: Pick<WidgetSettingsRepository, 'row'>;
  readonly #widget: Pick<WidgetRepository, 'staffIdentities'>;
  readonly #cards: AgentCards;

  constructor(deps: {
    readonly db: Db;
    readonly presence: PresenceReader;
    readonly settings: Pick<WidgetSettingsRepository, 'row'>;
    readonly widget: Pick<WidgetRepository, 'staffIdentities'>;
    readonly cards: AgentCards;
  }) {
    this.#db = deps.db;
    this.#presence = deps.presence;
    this.#settings = deps.settings;
    this.#widget = deps.widget;
    this.#cards = deps.cards;
  }

  /** For a request that already holds the brand's transaction and settings. */
  async presenceIn(
    tx: DbTransaction,
    brandId: string,
    settings: ResolvedWidgetSettings,
  ): Promise<WidgetPresence> {
    const online = await this.#onlineIds(brandId);
    return {
      agentsOnline: online.length > 0,
      agents: await this.#agents(tx, settings, online),
    };
  }

  /**
   * For the server's own frames — a presence change, a socket or stream
   * opening — which have no request to borrow a transaction from. The read is
   * the system path of the brand they are about, named in the session settings.
   */
  async presence(brandId: string): Promise<WidgetPresence> {
    const online = await this.#onlineIds(brandId);
    if (online.length === 0) {
      return { agentsOnline: false, agents: [] };
    }
    const agents = await withSystemJob(this.#db, brandId, 'widget:presence', async (tx) =>
      this.#agents(tx, resolveWidgetSettings(await this.#settings.row(tx, brandId)), online),
    );
    return { agentsOnline: true, agents };
  }

  async #onlineIds(brandId: string): Promise<string[]> {
    return Object.entries(await this.#presence.mapOf(brandId)).flatMap(([userId, status]) =>
      status === 'online' ? [userId] : [],
    );
  }

  async #agents(
    tx: DbTransaction,
    settings: ResolvedWidgetSettings,
    online: readonly string[],
  ): Promise<WidgetOnlineAgent[]> {
    if (online.length === 0 || !settings.conversation.showAgentIdentity) {
      return [];
    }
    const cards = await this.#cards.of(await this.#widget.staffIdentities(tx, online), 'en');
    return [...cards.values()]
      .filter((card) => card.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, WIDGET_ONLINE_AGENTS_MAX)
      .map((card) => ({ name: card.name, avatarUrl: card.avatarUrl }));
  }
}
