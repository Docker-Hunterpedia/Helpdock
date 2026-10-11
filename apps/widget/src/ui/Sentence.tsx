import type { Vars } from '../i18n/translator.js';
import { useWidget } from './context.js';

const SLOT = /\{\{(\w+)\}\}/;

/**
 * A sentence from the catalog with the named values set apart as `<bdi>`
 * isolates. An email address or a ticket reference is left-to-right text in
 * a right-to-left sentence; run into it, the full stop after it and the digits
 * beside it are placed by the bidi algorithm's guess, and a screen reader
 * cannot tell where the value ends.
 */
export function Sentence({
  id,
  vars,
  isolate,
}: {
  id: string;
  vars: Vars;
  isolate: readonly string[];
}) {
  const { t } = useWidget();
  // A slot the translator is given no value for stays as written, so the
  // template comes back whole and splits into text (even) and slot names (odd).
  const parts = t(id).split(SLOT);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) {
          return part;
        }
        const value = String(vars[part] ?? '');
        return isolate.includes(part) ? <bdi key={index}>{value}</bdi> : value;
      })}
    </>
  );
}
