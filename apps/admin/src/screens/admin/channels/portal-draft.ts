import type { CustomDomain, PortalSettings, PortalSettingsUpdate } from '@helpdock/schemas';

/**
 * The form of Channels › Customer portal (M21-06, `Admin/Channels-CustomerPortal`)
 * as a value: what is on screen, whether it differs from what is stored, and
 * the request that would save it. Kept out of the component so the rules a
 * person can break by clicking ("only these" with nothing ticked) are read, and
 * tested, without rendering anything.
 */

export interface PortalDraft {
  readonly enabled: boolean;
  readonly newCustomers: boolean;
  /** Which radio is chosen. The ticked list is kept while "All departments" is chosen, so a mis-click loses nothing. */
  readonly scope: 'all' | 'only';
  readonly departmentIds: readonly string[];
}

export const draftOf = (settings: PortalSettings): PortalDraft => ({
  enabled: settings.enabled,
  newCustomers: settings.newCustomers,
  scope: settings.departmentIds === 'all' ? 'all' : 'only',
  departmentIds: settings.departmentIds === 'all' ? [] : settings.departmentIds,
});

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const isChanged = (draft: PortalDraft, stored: PortalSettings): boolean => {
  const base = draftOf(stored);

  return (
    draft.enabled !== base.enabled ||
    draft.newCustomers !== base.newCustomers ||
    draft.scope !== base.scope ||
    (draft.scope === 'only' && !sameIds(draft.departmentIds, base.departmentIds))
  );
};

/** "Only these" with nothing ticked cannot be saved: the api refuses it, and so does the form. */
export const hasNoDepartment = (draft: PortalDraft): boolean =>
  draft.scope === 'only' && draft.departmentIds.length === 0;

export const requestOf = (draft: PortalDraft): PortalSettingsUpdate => ({
  enabled: draft.enabled,
  newCustomers: draft.newCustomers,
  departmentIds: draft.scope === 'all' ? 'all' : [...draft.departmentIds],
});

/** One department ticked or unticked, keeping the order they were ticked in. */
export const toggled = (ids: readonly string[], id: string, on: boolean): readonly string[] =>
  on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((candidate) => candidate !== id);

/**
 * The address a customer types: the brand's primary verified help center
 * domain (or the first verified one) and `/tickets`, else the install's
 * fallback path `/hc/<brandId>` (ADR 0013). Shown without the scheme, as the
 * artboard draws it.
 */
export const portalAddress = (
  domains: readonly CustomDomain[],
  fallback: { readonly host: string; readonly brandId: string },
): string => {
  const verified = domains.filter((domain) => domain.state === 'verified');
  const chosen = verified.find((domain) => domain.primary) ?? verified[0];

  return chosen === undefined
    ? `${fallback.host}/hc/${fallback.brandId}/tickets`
    : `${chosen.domain}/tickets`;
};
