import type { SsoConnectionInput } from '@helpdock/schemas';

/** Admin/Settings-SSO-M18 "Start from" choices (M18-09). Presets exist only for OIDC. */
export const SSO_PRESET_IDS = ['custom', 'google-workspace', 'entra-id'] as const;
export type SsoPresetId = (typeof SSO_PRESET_IDS)[number];

/** The template text an Entra issuer carries until the admin pastes their Directory (tenant) ID. */
const ENTRA_TENANT_PLACEHOLDER = '{tenant-id}';

const GUIDE = 'https://github.com/Docker-Hunterpedia/Helpdock/blob/main/docs/guides/sso.md';

type PresetFields = {
  readonly issuer: string;
  readonly emailClaim: string;
  readonly nameClaim: string;
  readonly groupAttribute: string | null;
};

/**
 * The fields a preset owns. Choosing a preset overwrites only these; the label,
 * client credentials, scopes, domains and access rules stay as the admin left them.
 */
const PRESETS: Record<SsoPresetId, PresetFields> = {
  custom: { issuer: '', emailClaim: 'email', nameClaim: 'name', groupAttribute: null },
  'google-workspace': {
    issuer: 'https://accounts.google.com',
    emailClaim: 'email',
    nameClaim: 'name',
    // Google puts no groups in the ID token.
    groupAttribute: null,
  },
  'entra-id': {
    issuer: `https://login.microsoftonline.com/${ENTRA_TENANT_PLACEHOLDER}/v2.0`,
    emailClaim: 'email',
    nameClaim: 'name',
    groupAttribute: 'groups',
  },
};

export const SSO_PRESET_GUIDES: Record<Exclude<SsoPresetId, 'custom'>, string> = {
  'google-workspace': `${GUIDE}#google-workspace-oidc-preset`,
  'entra-id': `${GUIDE}#microsoft-entra-id-oidc-preset`,
};

/**
 * Fills the preset's fields into an OIDC draft. Applied once, when the admin
 * picks the preset; later edits are ordinary edits and never re-apply it, and
 * nothing about the preset is saved with the connection.
 */
export function applySsoPreset(draft: SsoConnectionInput, preset: SsoPresetId): SsoConnectionInput {
  if (draft.config.protocol !== 'oidc') return draft;
  const { groupAttribute, ...config } = PRESETS[preset];
  return { ...draft, groupAttribute, config: { ...draft.config, ...config } };
}

/** True while an issuer still carries a preset's template text instead of a real value. */
export function hasIssuerPlaceholder(draft: SsoConnectionInput): boolean {
  return draft.config.protocol === 'oidc' && draft.config.issuer.includes(ENTRA_TENANT_PLACEHOLDER);
}
