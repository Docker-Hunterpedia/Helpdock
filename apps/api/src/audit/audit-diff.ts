import { isSettingKey, settingDefinitions } from '@helpdock/config';
import { AUDIT_REDACTED, type AuditChange, type AuditDetail } from '@helpdock/schemas';

/**
 * An audit row's `meta` as the viewer's table (M3-08): what changed, before and
 * after, and whatever else the row recorded — with every secret replaced.
 *
 * **Writers do not agree on a shape.** M0 and M1 wrote `{ before, after }`,
 * `{ from, to }`, `{ name, changes }` and plain facts such as
 * `{ detachedFrom: 12 }`. Rather than rewrite two years of rows, this reads
 * all of them: a before/after or from/to pair becomes changes, a `changes`
 * object becomes changes with no "before", and the rest becomes details.
 *
 * **Redaction is by name, twice over.** A field whose last segment looks like a
 * credential (`password`, `secret`, `token`, `apiKey`…) or that is a setting
 * the registry marks `secret` reads `[redacted]` on both sides, and the row
 * says only that it changed. The artboard's promise is "a secret field shows
 * that it changed and nothing else"; a writer that one day records one by
 * mistake is still not a reader that shows it.
 */

/** Dotted paths deeper than this are shown as JSON rather than split further. */
const MAX_DEPTH = 3;
/** A value longer than this is cut: the viewer is a table, not a document. */
const MAX_VALUE_LENGTH = 500;

const SECRET_NAME =
  /(pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|credentials?|cookies?|authorization|otp|totp)$/i;

/** Whether a dotted field names a secret, by its own name or by the settings registry. */
export const isSecretField = (field: string): boolean => {
  const last = field.split('.').at(-1) ?? field;
  if (SECRET_NAME.test(last)) {
    return true;
  }

  // `smtp.password` is a setting key, and so may be `to.smtp.password`.
  const segments = field.split('.');
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join('.');
    if (isSettingKey(candidate) && settingDefinitions[candidate].secret) {
      return true;
    }
  }

  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One value as the table prints it. */
const printable = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
};

/** `{ a: { b: 1 } }` as `[['a.b', 1]]`, down to {@link MAX_DEPTH}. */
const flatten = (value: Record<string, unknown>, prefix = '', depth = 1): [string, unknown][] =>
  Object.entries(value).flatMap(([key, inner]): [string, unknown][] => {
    const path = prefix === '' ? key : `${prefix}.${key}`;

    return isRecord(inner) && depth < MAX_DEPTH && !isSecretField(path)
      ? flatten(inner, path, depth + 1)
      : [[path, inner]];
  });

const changesBetween = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditChange[] => {
  const beforeFlat = new Map(flatten(before));
  const afterFlat = new Map(flatten(after));
  const fields = [...new Set([...beforeFlat.keys(), ...afterFlat.keys()])];

  return fields.map((field) => {
    const secret = isSecretField(field);

    return {
      field,
      before: secret ? AUDIT_REDACTED : printable(beforeFlat.get(field)),
      after: secret ? AUDIT_REDACTED : printable(afterFlat.get(field)),
      secret,
    };
  });
};

/** The pair of keys a writer used for its before and after, if it used one. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['before', 'after'],
  ['from', 'to'],
];

export const auditDiffOf = (
  meta: Record<string, unknown>,
): { changes: AuditChange[]; details: AuditDetail[] } => {
  const rest = { ...meta };
  const changes: AuditChange[] = [];

  for (const [beforeKey, afterKey] of PAIRS) {
    const before = rest[beforeKey];
    const after = rest[afterKey];
    if ((isRecord(before) || before === undefined) && (isRecord(after) || after === undefined)) {
      if (before === undefined && after === undefined) {
        continue;
      }
      changes.push(...changesBetween(before ?? {}, after ?? {}));
      delete rest[beforeKey];
      delete rest[afterKey];
    }
  }

  if (isRecord(rest.changes)) {
    changes.push(...changesBetween({}, rest.changes));
    delete rest.changes;
  }

  const details = flatten(rest).map(([field, value]) => {
    const secret = isSecretField(field);

    return { field, value: secret ? AUDIT_REDACTED : printable(value), secret };
  });

  return { changes, details };
};
