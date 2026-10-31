import { type Macro, splitName } from '@helpdock/schemas';
import { useMemo } from 'react';
import { useTicketsApi } from '../../auth/session.tsx';
import type { StagedMacro } from '../../tickets/macro-staging.js';
import type { ComposerInline } from './composer.tsx';
import { replaceTrigger } from './composer-triggers.js';

/**
 * What the composer needs to open its lists as one types (M14-14): the values
 * `{{` can insert for this ticket, and what choosing a saved reply after `/`
 * does with the text.
 *
 * Choosing one fills it in for this ticket in the contact's language, as the
 * picker does, puts it where the `/word` was, and stages its actions. A macro
 * with no reply has nothing to put in the text, so the word goes and it runs at
 * once, as the picker's does.
 */

export interface UseComposerInlineArgs {
  readonly brandId: string;
  readonly ticketId: string;
  readonly departmentId: string;
  readonly departmentName: string | null;
  readonly reference: string;
  readonly brandName: string | null;
  readonly contact: { readonly name: string; readonly email: string | null } | null;
  readonly viewerName: string;
  /** The language the reply is filled in for. */
  readonly locale: 'en' | 'ar';
  /** The composer's text now, read when the reply arrives. */
  readonly body: string;
  setBody(update: (held: string) => string): void;
  setStaged(staged: StagedMacro): void;
  runNow(macro: Macro): void;
  onError(error: unknown): void;
}

interface PlaceholderSource {
  readonly reference: string;
  readonly brandName: string | null;
  readonly departmentName: string | null;
  readonly viewerName: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
}

/** Only a value this ticket gives: a placeholder with none is not offered. */
const valuesFor = (source: PlaceholderSource): ReadonlyMap<string, string> => {
  const { first, last } = splitName(source.contactName ?? '');
  const entries: [string, string | null][] = [
    ['ticket.number', source.reference],
    ['brand.name', source.brandName],
    ['department.name', source.departmentName],
    ['agent.first_name', splitName(source.viewerName).first],
    ['agent.full_name', source.viewerName],
    ['contact.first_name', first],
    ['contact.last_name', last],
    ['contact.name', source.contactName],
    ['contact.email', source.contactEmail],
  ];

  return new Map(entries.filter((entry): entry is [string, string] => (entry[1] ?? '') !== ''));
};

export const useComposerInline = (args: UseComposerInlineArgs): ComposerInline => {
  const api = useTicketsApi();
  const { brandId, ticketId, departmentId, setBody, setStaged, runNow, onError, locale } = args;
  const { reference, brandName, departmentName, viewerName } = args;
  const contactName = args.contact?.name ?? null;
  const contactEmail = args.contact?.email ?? null;
  const placeholderValues = useMemo(
    () =>
      valuesFor({ reference, brandName, departmentName, viewerName, contactName, contactEmail }),
    [reference, brandName, departmentName, viewerName, contactName, contactEmail],
  );

  return {
    brandId,
    departmentId,
    ticketId,
    placeholderValues,
    onInsertSaved: async (macro, range) => {
      const word = args.body.slice(range.start, range.end);
      let caret: number | null = null;

      if (macro.bodies.en.trim() === '') {
        setBody((held) => replaceTrigger(held, range, word, '').text);
        runNow(macro);
        return null;
      }

      try {
        const rendered = await api.renderMacro(brandId, ticketId, macro.id, locale);
        setBody((held) => {
          const next = replaceTrigger(held, range, word, rendered.text);
          caret = next.caret;
          return next.text;
        });
        setStaged({ macro: { id: macro.id, name: macro.name }, actions: macro.actions });
      } catch (error) {
        onError(error);
      }

      return caret;
    },
  };
};
