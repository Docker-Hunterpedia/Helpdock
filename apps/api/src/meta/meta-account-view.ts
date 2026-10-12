import { META_TOKEN_HINT_LENGTH, type MetaAccount, metaAccountHealth } from '@helpdock/schemas';
import type { AccountWithNames } from './meta.repository.js';
import { iso } from './meta-view.js';

/**
 * A `meta_accounts` row as Channels › Meta reads it (M10-07). The token is
 * reduced to "is there one" and its last characters, which is all REQUIREMENTS
 * §5.1 lets leave the server, so the view takes the decrypted token only to cut
 * those few characters off it and keeps nothing else of it.
 */

/** The last characters of a token, which is all of it the screen shows. */
export const tokenHint = (token: string): string => token.slice(-META_TOKEN_HINT_LENGTH);

export const toMetaAccount = (
  { account, departmentName, tokenUpdatedByName }: AccountWithNames,
  plainToken: string,
): MetaAccount => ({
  id: account.id,
  platform: account.platform,
  externalId: account.externalId,
  wabaId: account.wabaId,
  displayPhone: account.displayPhone,
  username: account.username,
  displayName: account.displayName,
  departmentId: account.departmentId,
  departmentName,
  tokenSet: account.accessToken !== '',
  tokenHint: tokenHint(plainToken),
  tokenKind: account.tokenKind,
  tokenExpiresAt: iso(account.tokenExpiresAt),
  tokenUpdatedAt: account.tokenUpdatedAt.toISOString(),
  tokenUpdatedByName,
  humanAgentEnabled: account.humanAgentEnabled,
  subscribedFields: account.subscribedFields,
  subscribedAt: iso(account.subscribedAt),
  status: account.status,
  health: metaAccountHealth(account),
  lastEventAt: iso(account.lastEventAt),
  lastError: account.lastError,
  lastErrorAt: iso(account.lastErrorAt),
  createdAt: account.createdAt.toISOString(),
});
