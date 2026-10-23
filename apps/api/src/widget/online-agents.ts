import type { Db, DbTransaction } from '@helpdock/db';
import {
  type PresenceMap,
  publicNameOf,
  WIDGET_ONLINE_AGENTS_MAX,
  type WidgetOnlineAgent,
  type WidgetPresence,
} from '@helpdock/schemas';
import { withSystemJob } from '../tenant/system-job.js';
import { type ResolvedWidgetSettings, resolveWidgetSettings } from './resolved-settings.js';
import type { WidgetRepository } from './widget.repository.js';
import type { WidgetSettingsRepository } from './widget-settings.repository.js';

export interface PresenceReader {
  mapOf(brandId: string): Promise<PresenceMap>;
}

/**
 * "Lina, Karim and Sara are online now" (M4-08): who of the brand is online,
 * as a visitor may see them — public names (M14-12), sorted so the line does
 * not shuffle between frames, and nothing at all when the brand turned off
 * "Show the agent's name and photo". Names only: a photo is presigned solely
 * for the author of a message in the visitor's own conversation
 * (DOMAIN-RULES §2.10.4), and this line reaches every visitor of the brand,
 * including those nobody has answered, so the widget draws the initials.
 */
export class OnlineAgents {
  readonly #db: Db;
  readonly #presence: PresenceReader;
  readonly #settings: Pick<WidgetSettingsRepository, 'row'>;
  readonly #widget: Pick<WidgetRepository, 'staffIdentities'>;

  constructor(deps: {
    readonly db: Db;
    readonly presence: PresenceReader;
    readonly settings: Pick<WidgetSettingsRepository, 'row'>;
    readonly widget: Pick<WidgetRepository, 'staffIdentities'>;
  }) {
    this.#db = deps.db;
    this.#presence = deps.presence;
    this.#settings = deps.settings;
    this.#widget = deps.widget;
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
    // The cards the thread builds are not read here: they presign a photo per
    // person, and a photo may be issued only for a message's author in the
    // visitor's own conversation. The name alone is this line's to say.
    const identities = await this.#widget.staffIdentities(tx, online);
    return [...identities.values()]
      .map((row) => publicNameOf(row))
      .filter((name) => name !== '')
      .sort((a, b) => a.localeCompare(b))
      .slice(0, WIDGET_ONLINE_AGENTS_MAX)
      .map((name) => ({ name }));
  }
}
