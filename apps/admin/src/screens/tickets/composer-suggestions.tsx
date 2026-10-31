import type { Macro } from '@helpdock/schemas';
import { monoFontStyle } from '@helpdock/ui';
import { Box, Paper, Typography } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useTicketingApi, useTicketsApi } from '../../auth/session.tsx';
import { PresenceDot } from '../../ui/presence-dot.tsx';
import { matchSavedReplies } from './saved-reply-order.js';

/**
 * The lists that open under the composer's text as one types (DESIGN §6.1 SuggestionList and MentionPicker,
 * `Admin/Composer-Shortcuts`): `/refund` offers the saved replies and macros.
 *
 * Focus stays in the textarea. The list is a listbox the textarea points at
 * with `aria-controls` and `aria-activedescendant`, so a screen reader hears
 * the active option while the person keeps typing; ↑ ↓ move, Tab and Enter
 * choose, Esc closes. The composer hands each key to {@link SuggestionKeys}
 * first, and the open list says whether it used it.
 */

/** Returns true when it used the key. The open list sets it, and clears it when it closes. */
export type SuggestionKeys = (event: KeyboardEvent<HTMLElement>) => boolean;

export interface SuggestionList {
  readonly id: string;
  /** Moves with the arrows; the textarea's `aria-activedescendant`. */
  onActive(optionId: string | null): void;
  readonly keys: MutableRefObject<SuggestionKeys | null>;
  onDismiss(): void;
}

/** Registers the open list's key handling with the composer for as long as it is mounted. */
export const useSuggestionKeys = (
  list: SuggestionList,
  options: { readonly count: number; active: number; setActive(next: number): void; pick(): void },
): void => {
  const { keys, onDismiss } = list;
  const { count, active, setActive, pick } = options;

  useEffect(() => {
    keys.current = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return true;
      }
      if (count === 0) {
        return false;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return false;
        }
        event.preventDefault();
        pick();
        return true;
      }

      return false;
    };

    return () => {
      keys.current = null;
    };
  }, [keys, onDismiss, count, active, setActive, pick]);
};

/** The shell of a suggestion list: a listbox in a small card, with a hint line. */
export function SuggestionCard({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Paper
      elevation={2}
      sx={{ padding: 1, display: 'grid', gap: 1, borderRadius: '6px', minWidth: 0 }}
    >
      <Box id={id} role="listbox" aria-label={label} sx={{ maxHeight: 240, overflowY: 'auto' }}>
        {children}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', paddingInline: 2 }}>
        {hint}
      </Typography>
    </Paper>
  );
}

/** One row: a name, a caption, and a trailing mono tag. */
export function SuggestionOption({
  id,
  selected,
  name,
  caption,
  tag,
  onChoose,
  onHover,
}: {
  readonly id: string;
  readonly selected: boolean;
  readonly name: ReactNode;
  readonly caption: ReactNode;
  readonly tag?: ReactNode;
  onChoose(): void;
  onHover(): void;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      id={id}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => {
        // Before the textarea blurs, so the choice lands where the caret was.
        event.preventDefault();
        onChoose();
      }}
      onMouseMove={onHover}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        minHeight: 40,
        paddingInline: 2,
        borderRadius: '4px',
        cursor: 'pointer',
        backgroundColor: selected ? tokens['action.primary.tint'] : undefined,
        '&:hover': { backgroundColor: selected ? undefined : tokens['bg.muted'] },
      }}
    >
      <Box sx={{ display: 'grid', minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
          {name}
        </Typography>
        <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>
          {caption}
        </Typography>
      </Box>
      {tag === undefined ? null : (
        <Box component="code" sx={{ ...monoFontStyle, fontSize: 12, color: 'text.secondary' }}>
          <bdi>{tag}</bdi>
        </Box>
      )}
    </Box>
  );
}

export interface SavedReplySuggestionsProps {
  readonly brandId: string;
  readonly departmentId: string;
  /** What follows the `/`. */
  readonly query: string;
  readonly list: SuggestionList;
  onPick(macro: Macro): void;
}

/** `/` in a reply: the saved replies and macros that may be used on this ticket, filtered by what follows it. */
export function SavedReplySuggestions({
  brandId,
  departmentId,
  query,
  list,
  onPick,
}: SavedReplySuggestionsProps): ReactNode {
  const t = useT();
  const ticketingApi = useTicketingApi();
  const [active, setActive] = useState(0);

  // The picker's key, so the two share one cache entry.
  const macros = useQuery({
    queryKey: ['macros', brandId, 'department', departmentId],
    queryFn: () => ticketingApi.macros(brandId, { departmentId }),
  });
  const matches = useMemo(
    () => matchSavedReplies(macros.data?.macros ?? [], query),
    [macros.data, query],
  );
  const current = Math.min(active, Math.max(matches.length - 1, 0));
  const selected = matches[current];
  const optionId = (macro: Macro): string => `${list.id}-${macro.id}`;

  // The first match is active again whenever the word changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger, not a read.
  useEffect(() => {
    setActive(0);
  }, [query]);

  const { onActive } = list;
  useEffect(() => {
    onActive(selected === undefined ? null : `${list.id}-${selected.id}`);
    return () => {
      onActive(null);
    };
  }, [onActive, list.id, selected]);

  useSuggestionKeys(list, {
    count: matches.length,
    active: current,
    setActive,
    pick: () => {
      if (selected !== undefined) {
        onPick(selected);
      }
    },
  });

  if (macros.isPending) {
    return null;
  }

  return (
    <>
      <SuggestionCard
        id={list.id}
        label={t('tickets:composer.suggest.savedReplies')}
        hint={t('tickets:composer.suggest.hint')}
      >
        {matches.map((macro, index) => (
          <SuggestionOption
            key={macro.id}
            id={optionId(macro)}
            selected={index === current}
            name={macro.name}
            caption={caption(macro, t)}
            tag={macro.shortcut === null ? undefined : `/${macro.shortcut}`}
            onChoose={() => {
              onPick(macro);
            }}
            onHover={() => {
              setActive(index);
            }}
          />
        ))}
        {matches.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', padding: 2 }}>
            {t('tickets:composer.suggest.none')}
          </Typography>
        ) : null}
      </SuggestionCard>
      <Typography
        role="status"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        {t('tickets:composer.suggest.count', { count: matches.length })}
      </Typography>
    </>
  );
}

const caption = (macro: Macro, t: ReturnType<typeof useT>): string => {
  if (macro.kind === 'macro') {
    return macro.bodies.en.trim() === ''
      ? t('macros:picker.optionMacroNoReply', { count: macro.actions.length })
      : t('macros:picker.optionMacro', { count: macro.actions.length });
  }
  const who = t(
    macro.scope === 'personal' ? 'tickets:composer.suggest.you' : 'tickets:composer.suggest.brand',
  );

  return macro.useCount === 0
    ? who
    : t('tickets:composer.suggest.used', { count: macro.useCount, who });
};

export interface MentionSuggestionsProps {
  readonly brandId: string;
  readonly ticketId: string;
  /** What follows the `@`. */
  readonly query: string;
  readonly list: SuggestionList;
  /** The handle to write after the `@`. */
  onPick(handle: string): void;
}

/**
 * `@` in a note (M14-15): the people who can see this ticket's department, with
 * presence, filtered as one types in either script. The api decides who may be
 * offered; choosing writes the handle its notification path already reads.
 */
export function MentionSuggestions({
  brandId,
  ticketId,
  query,
  list,
  onPick,
}: MentionSuggestionsProps): ReactNode {
  const t = useT();
  const ticketsApi = useTicketsApi();
  const [active, setActive] = useState(0);

  const people = useQuery({
    queryKey: ['mention-candidates', brandId, ticketId, query],
    queryFn: () => ticketsApi.mentionCandidates(brandId, ticketId, query),
    // The previous word's people stay up while the next word's arrive.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const candidates = people.data?.candidates ?? [];
  const current = Math.min(active, Math.max(candidates.length - 1, 0));
  const selected = candidates[current];

  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger, not a read.
  useEffect(() => {
    setActive(0);
  }, [query]);

  const { onActive } = list;
  useEffect(() => {
    onActive(selected === undefined ? null : `${list.id}-${selected.userId}`);
    return () => {
      onActive(null);
    };
  }, [onActive, list.id, selected]);

  useSuggestionKeys(list, {
    count: candidates.length,
    active: current,
    setActive,
    pick: () => {
      if (selected !== undefined) {
        onPick(selected.handle);
      }
    },
  });

  if (people.isPending) {
    return null;
  }

  return (
    <>
      <SuggestionCard
        id={list.id}
        label={t('tickets:composer.mention.label')}
        hint={t('tickets:composer.suggest.hint')}
      >
        {candidates.map((person, index) => (
          <SuggestionOption
            key={person.userId}
            id={`${list.id}-${person.userId}`}
            selected={index === current}
            name={
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <PresenceDot status={person.presence} />
                <bdi>{person.name}</bdi>
              </Box>
            }
            caption={
              <>
                <bdi>@{person.handle}</bdi> · {t(`admin:presence.status.${person.presence}`)}
              </>
            }
            onChoose={() => {
              onPick(person.handle);
            }}
            onHover={() => {
              setActive(index);
            }}
          />
        ))}
        {candidates.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', padding: 2 }}>
            {t('tickets:composer.mention.none')}
          </Typography>
        ) : null}
      </SuggestionCard>
      <Typography
        role="status"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        {t('tickets:composer.mention.count', { count: candidates.length })}
      </Typography>
    </>
  );
}
