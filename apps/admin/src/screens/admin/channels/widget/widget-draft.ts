import {
  ATTACHMENT_MAX_BYTES_CEILING,
  ATTACHMENTS_PER_MESSAGE_CEILING,
  type ContentPolicy,
  type MediaPolicy,
  mimeTypeSchema,
  type PrechatField,
  WIDGET_ACCENT_MIN_CONTRAST,
  whiteContrastOn,
  widgetOriginSchema,
} from '@helpdock/schemas';

/**
 * The Widget tab's drafts: what each card holds while it is being edited, and
 * the request it becomes on Save, or the fields that stop it. Pure, so the
 * rules the api enforces are tested here without a screen.
 */

// ------------------------------------------------------------------ accent

export type AccentCheck =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'pass' | 'fail'; readonly ratio: number };

/** The artboard's line under the Accent field: the ratio of white text on it, and whether it passes. */
export const checkAccent = (value: string): AccentCheck => {
  const hex = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return { kind: 'invalid' };
  }
  const ratio = Math.round(whiteContrastOn(hex) * 10) / 10;
  return { kind: whiteContrastOn(hex) >= WIDGET_ACCENT_MIN_CONTRAST ? 'pass' : 'fail', ratio };
};

// ---------------------------------------------------------------- origins

export type OriginCheck =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'duplicate' };

/** What "Add origin" does with the text typed: the normalised origin, or why not. */
export const checkOrigin = (input: string, existing: readonly string[]): OriginCheck => {
  const parsed = widgetOriginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' };
  }
  return existing.includes(parsed.data)
    ? { ok: false, reason: 'duplicate' }
    : { ok: true, origin: parsed.data };
};

// ---------------------------------------------------------- pre-chat fields

export const prechatKeyOf = (field: PrechatField): string =>
  field.kind === 'custom' ? field.key : field.kind;

/** The list with one field moved by `delta` (−1 up, +1 down), clamped at the ends. */
export const moveField = (
  fields: readonly PrechatField[],
  key: string,
  delta: -1 | 1,
): PrechatField[] => {
  const from = fields.findIndex((field) => prechatKeyOf(field) === key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= fields.length) {
    return [...fields];
  }
  const next = [...fields];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) {
    next.splice(to, 0, moved);
  }
  return next;
};

// --------------------------------------------------------- content policy

export const MIB = 1_048_576;
export const POLICY_KINDS = ['image', 'video', 'voice', 'file'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** The install's ceiling on any one upload, in whole MB, as the artboard's error names it. */
export const UPLOAD_LIMIT_MB = Math.floor(ATTACHMENT_MAX_BYTES_CEILING / MIB);

interface KindDraft {
  enabled: boolean;
  /** As typed, so "1o" stays on screen to be corrected. */
  maxMb: string;
  /** Comma-separated MIME types, as typed. */
  types: string;
}

export interface PolicyDraft {
  emoji: boolean;
  kinds: Record<PolicyKind, KindDraft>;
  perMessage: string;
}

export const policyDraftOf = (policy: ContentPolicy): PolicyDraft => {
  const kind = (media: MediaPolicy): KindDraft => ({
    enabled: media.enabled,
    maxMb: String(Math.max(1, Math.round(media.maxBytes / MIB))),
    types: media.allowedMime.join(', '),
  });
  return {
    emoji: policy.emoji,
    kinds: {
      image: kind(policy.image),
      video: kind(policy.video),
      voice: kind(policy.voice),
      file: kind(policy.file),
    },
    perMessage: String(policy.maxAttachmentsPerMessage),
  };
};

/** `size:image`, `types:video`, `perMessage`, and `tooLarge:video` for a size above the ceiling. */
export type PolicyProblem = `${'size' | 'tooLarge' | 'types'}:${PolicyKind}` | 'perMessage';

export const policyRequestOf = (
  draft: PolicyDraft,
  base: ContentPolicy,
):
  | { readonly ok: true; readonly request: ContentPolicy }
  | { readonly ok: false; readonly problems: ReadonlySet<PolicyProblem> } => {
  const problems = new Set<PolicyProblem>();
  const media = {} as Record<PolicyKind, MediaPolicy>;

  for (const kind of POLICY_KINDS) {
    const held = draft.kinds[kind];
    const mb = /^\d+$/.test(held.maxMb.trim()) ? Number(held.maxMb.trim()) : Number.NaN;
    const types = held.types
      .split(',')
      .map((type) => type.trim())
      .filter((type) => type !== '');
    const parsedTypes = types.map((type) => mimeTypeSchema.safeParse(type));

    if (!Number.isInteger(mb) || mb < 1) {
      problems.add(`size:${kind}`);
    } else if (mb > UPLOAD_LIMIT_MB) {
      problems.add(`tooLarge:${kind}`);
    }
    if (types.length === 0 || parsedTypes.some((type) => !type.success)) {
      problems.add(`types:${kind}`);
    }

    media[kind] = {
      enabled: held.enabled,
      maxBytes: Math.min(mb * MIB, ATTACHMENT_MAX_BYTES_CEILING),
      allowedMime: parsedTypes.flatMap((type) => (type.success ? [type.data] : [])),
    };
  }

  const perMessage = /^\d+$/.test(draft.perMessage.trim()) ? Number(draft.perMessage) : Number.NaN;
  if (!Number.isInteger(perMessage) || perMessage > ATTACHMENTS_PER_MESSAGE_CEILING) {
    problems.add('perMessage');
  }

  return problems.size > 0
    ? { ok: false, problems }
    : {
        ok: true,
        request: {
          ...base,
          text: true,
          emoji: draft.emoji,
          ...media,
          maxAttachmentsPerMessage: perMessage,
        },
      };
};
