import type { Department, TagSummary, TicketView } from '@helpdock/schemas';
import { ticketPrioritySchema, VIEW_NAME_MAX_LENGTH } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field } from '../../../ui/field.tsx';
import { DepartmentChoice } from '../../tickets/view-dialogs.tsx';
import {
  ASSIGNEE_CHOICES,
  type AssigneeChoice,
  type Audience,
  assigneeChoice,
  draftComplete,
  draftOf,
  type PriorityChoice,
  priorityChoice,
  SAVED,
  SORT_CHOICES,
  type SortChoice,
  STATE_CHOICES,
  type StateChoice,
  sortChoice,
  stateChoice,
  type ViewDraft,
  withAssigneeChoice,
  withPriorityChoice,
  withSortChoice,
  withStateChoice,
} from './view-draft.js';

/**
 * The "Edit view" card of `Admin/Ticketing-Views` (M1-05): names in both
 * languages, who sees it, and the filters as a handful of selects.
 *
 * A built-in view draws its audience and filters disabled rather than hiding
 * them, with the sentence saying why: they are what the view *is*, and the
 * person renaming "Overdue" should still see what it shows.
 */
export function ViewEditor({
  view,
  departments,
  tags,
  busy,
  onSubmit,
  onCancel,
  onDelete,
}: {
  /** Null while the card is making a new shared view. */
  readonly view: TicketView | null;
  readonly departments: readonly Department[];
  readonly tags: readonly TagSummary[];
  readonly busy: boolean;
  onSubmit(draft: ViewDraft): void;
  onCancel(): void;
  /** Absent while creating, and for a built-in view, which is never deleted. */
  onDelete?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const nameId = useId();
  const nameArId = useId();
  const audienceId = useId();
  const tagsId = useId();
  const ids = {
    state: useId(),
    assignee: useId(),
    priority: useId(),
    sla: useId(),
    sort: useId(),
  };

  const [draft, setDraft] = useState<ViewDraft>(() => draftOf(view));
  const fixed = view?.builtIn != null;

  // Re-filled when another row is chosen, not on every background refetch, so
  // half a typed name survives the counts refreshing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different view" is its id.
  useEffect(() => {
    setDraft(draftOf(view));
  }, [view?.id]);

  const set = (patch: Partial<ViewDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const filters = draft.filters;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (draftComplete(draft)) {
      onSubmit(draft);
    }
  };

  const heading =
    view === null
      ? t('ticketing:views.editor.newHeading')
      : t('ticketing:views.editor.heading', { name: view.name });

  const select = (
    id: string,
    label: string,
    value: string,
    options: readonly { readonly value: string; readonly label: string }[],
    onChange: (value: string) => void,
  ): ReactNode => (
    <>
      <Typography component="label" htmlFor={id} sx={{ fontSize: 12, color: 'text.secondary' }}>
        {label}
      </Typography>
      <TextField
        id={id}
        select
        size="small"
        value={value}
        disabled={fixed}
        slotProps={{ select: { native: true } }}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </TextField>
    </>
  );

  /** The select's choices, plus "as saved" while the view holds something it cannot draw. */
  const withSaved = <T extends string>(
    current: string,
    options: readonly { readonly value: T; readonly label: string }[],
  ) =>
    current === SAVED || !options.some((option) => option.value === current)
      ? [...options, { value: current, label: t('ticketing:views.editor.saved') }]
      : options;

  const stateLabel = (choice: (typeof STATE_CHOICES)[number]): string =>
    choice === 'any'
      ? t('ticketing:views.editor.anyState')
      : choice === 'live'
        ? t('ticketing:views.editor.anyLive')
        : t(`tickets:filters.states.${choice}`);

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={heading}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2">
        {heading}
      </Typography>

      <Field id={nameId} label={t('ticketing:views.editor.name')}>
        <TextField
          id={nameId}
          value={draft.name}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: VIEW_NAME_MAX_LENGTH } }}
          onChange={(event) => {
            set({ name: event.target.value });
          }}
        />
      </Field>

      <Field id={nameArId} label={t('ticketing:views.editor.nameAr')}>
        <TextField
          id={nameArId}
          value={draft.nameAr}
          size="small"
          slotProps={{ htmlInput: { maxLength: VIEW_NAME_MAX_LENGTH, dir: 'rtl', lang: 'ar' } }}
          onChange={(event) => {
            set({ nameAr: event.target.value });
          }}
        />
      </Field>

      <Box component="fieldset" disabled={fixed} sx={{ border: 0, padding: 0, margin: 0 }}>
        <Typography
          component="legend"
          id={audienceId}
          sx={{ fontSize: 13, fontWeight: 500, paddingBlockEnd: '6px' }}
        >
          {t('ticketing:views.editor.visibleTo')}
        </Typography>
        <RadioGroup
          aria-labelledby={audienceId}
          value={draft.audience}
          onChange={(event) => {
            set({ audience: event.target.value as Audience });
          }}
        >
          <FormControlLabel
            value="brand"
            disabled={fixed}
            control={<Radio size="small" />}
            label={t('ticketing:views.editor.brand')}
          />
          <FormControlLabel
            value="departments"
            disabled={fixed}
            control={<Radio size="small" />}
            label={t('ticketing:views.editor.departments')}
          />
        </RadioGroup>
        {draft.audience === 'departments' && !fixed ? (
          <DepartmentChoice
            departments={departments}
            chosen={draft.departmentIds}
            onChange={(departmentIds) => {
              set({ departmentIds });
            }}
          />
        ) : null}
      </Box>

      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          paddingBlock: 3,
          paddingInline: 3,
          borderRadius: '8px',
          backgroundColor: tokens['bg.muted'],
        }}
      >
        <Typography component="h3" sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('ticketing:views.editor.filters')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '88px minmax(0, 1fr)',
            gap: 2,
            alignItems: 'center',
          }}
        >
          {select(
            ids.state,
            t('ticketing:views.editor.state'),
            stateChoice(filters),
            withSaved(
              stateChoice(filters),
              STATE_CHOICES.map((choice) => ({ value: choice, label: stateLabel(choice) })),
            ),
            (value) => {
              set({ filters: withStateChoice(filters, value as StateChoice) });
            },
          )}
          {select(
            ids.assignee,
            t('ticketing:views.editor.assignee'),
            assigneeChoice(filters),
            withSaved(
              assigneeChoice(filters),
              ASSIGNEE_CHOICES.map((choice) => ({
                value: choice,
                label: t(
                  choice === 'any'
                    ? 'ticketing:views.editor.anyone'
                    : choice === 'me'
                      ? 'ticketing:views.editor.me'
                      : 'ticketing:views.editor.nobody',
                ),
              })),
            ),
            (value) => {
              set({ filters: withAssigneeChoice(filters, value as AssigneeChoice) });
            },
          )}
          {select(
            ids.priority,
            t('ticketing:views.editor.priority'),
            priorityChoice(filters),
            withSaved(priorityChoice(filters), [
              { value: 'any', label: t('ticketing:views.editor.any') },
              ...ticketPrioritySchema.options.map((priority) => ({
                value: priority,
                label: t(`tickets:priority.${priority}`),
              })),
            ]),
            (value) => {
              set({ filters: withPriorityChoice(filters, value as PriorityChoice) });
            },
          )}

          <Typography id={tagsId} component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
            {t('ticketing:views.editor.tags')}
          </Typography>
          <Box
            role="group"
            aria-labelledby={tagsId}
            sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
          >
            {tags.map((tag) => {
              const on = filters.tagIds.includes(tag.id);
              return (
                <Chip
                  key={tag.id}
                  size="small"
                  disabled={fixed}
                  label={locale === 'ar' && tag.nameAr !== null ? tag.nameAr : tag.name}
                  color={on ? 'primary' : 'default'}
                  variant={on ? 'filled' : 'outlined'}
                  aria-pressed={on}
                  onClick={() => {
                    set({
                      filters: {
                        ...filters,
                        tagIds: on
                          ? filters.tagIds.filter((id) => id !== tag.id)
                          : [...filters.tagIds, tag.id],
                      },
                    });
                  }}
                />
              );
            })}
          </Box>

          {select(
            ids.sla,
            t('ticketing:views.editor.sla'),
            filters.overdue ? 'overdue' : 'any',
            [
              { value: 'any', label: t('ticketing:views.editor.any') },
              { value: 'overdue', label: t('ticketing:views.editor.overdue') },
            ],
            (value) => {
              set({ filters: { ...filters, overdue: value === 'overdue' } });
            },
          )}
          {select(
            ids.sort,
            t('ticketing:views.editor.sort'),
            sortChoice(filters),
            withSaved(
              sortChoice(filters),
              SORT_CHOICES.map((choice) => {
                const [sort, direction] = choice.split(':') as [
                  'updatedAt' | 'createdAt' | 'priority',
                  'asc' | 'desc',
                ];
                return { value: choice, label: t(`tickets:sort.${sort}.${direction}`) };
              }),
            ),
            (value) => {
              if (value !== SAVED) {
                set({ filters: withSortChoice(filters, value as SortChoice) });
              }
            },
          )}
        </Box>
      </Box>

      {fixed ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:views.editor.builtInNote')}
        </Typography>
      ) : null}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {onDelete === undefined ? null : (
          <Button variant="text" color="error" onClick={onDelete} disabled={busy}>
            {t('ticketing:views.editor.delete')}
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || !draftComplete(draft)}>
          {view === null ? t('ticketing:views.editor.create') : t('ticketing:views.editor.save')}
        </Button>
      </Box>
    </Box>
  );
}
