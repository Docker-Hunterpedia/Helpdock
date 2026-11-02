/**
 * Whether a form's draft differs from what is saved. A real comparison, not a
 * flag set on first keystroke: typing a letter and deleting it again leaves the
 * form clean, so Save and Discard go back to disabled.
 */
export function isDirty(draft: unknown, saved: unknown): boolean {
  return !sameValue(draft, saved);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) =>
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}
