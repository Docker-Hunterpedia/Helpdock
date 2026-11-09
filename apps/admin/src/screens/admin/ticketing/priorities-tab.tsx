import {
  PRIORITY_KEYS,
  PRIORITY_LABEL_MAX_LENGTH,
  type PriorityLabelLocale,
  type PriorityLabelsInput,
  type TicketPriority,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { isFieldValidationError } from '../../../ticketing/field-errors.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { LoadingSkeleton } from '../../../ui/loading-skeleton.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { Pill } from '../../tickets/badges.tsx';
import { PRIORITY_TONE } from '../../tickets/format.js';
import {
  draftOf,
  duplicateIssues,
  type FieldKey,
  fieldPath,
  firstInvalid,
  formatIssues,
  hasOverride,
  isDirty,
  type PriorityDraft,
  pillName,
  resetRow,
  showsDefault,
  toRequest,
  withField,
} from './priority-draft.js';

/**
 * The Priorities page of Settings › Inbox (`Admin/Ticketing-Priorities`, M1-02):
 * the brand's English and Arabic name for each of the four priorities.
 *
 * One form and one save, like Feedback: eight fields are one decision about how
 * the desk talks, and Save writes all four rows at once. The names are display
 * only; everything that is not a screen keeps `low | medium | high | urgent`.
 *
 * What is typed survives a refused save. A duplicate is found here, from the
 * same rule the api applies, and sits under the field edited last; Save moves
 * focus to the first invalid field instead of asking the api a question the
 * page can already answer. A field error the api still returns lands under its
 * field.
 */

/** Under this width a row stacks, as drawn. */
const NARROW = '@media (max-width:719.95px)';

const LOCALES: readonly PriorityLabelLocale[] = ['en', 'ar'];

export function PrioritiesTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { locale } = usePreferences();
  const brand = currentBrand(session);
  const idBase = useId();

  const brandQuery = useQuery({
    queryKey: ['brand', brand.id],
    queryFn: () => api.brand(brand.id),
  });
  const stored = brandQuery.data?.settings.priorityLabels;
  // A background refetch hands back a new object with the same names; only a
  // change of the names themselves may replace what is being typed.
  const storedKey = stored === undefined ? null : JSON.stringify(stored);

  const [draft, setDraft] = useState<PriorityDraft | null>(null);
  const [lastEdited, setLastEdited] = useState<FieldKey | null>(null);
  const [failed, setFailed] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlySet<string>>(new Set());
  // Bumped to draw once more, so the focus effect runs after a refused Save.
  const [, redraw] = useState(0);
  const pendingFocus = useRef<FieldKey | null>(null);

  // Re-filled when the stored names change under the form (after a save, or
  // after another page wrote them), and not on every keystroke.
  useEffect(() => {
    if (storedKey !== null) {
      setDraft(draftOf(JSON.parse(storedKey) as PriorityLabelsInput));
      setLastEdited(null);
      setServerIssues(new Set());
    }
  }, [storedKey]);

  const save = useMutation({
    mutationFn: (next: PriorityDraft) => api.updatePriorityLabels(brand.id, toRequest(next)),
    onSuccess: async () => {
      setFailed(false);
      await queryClient.invalidateQueries({ queryKey: ['brand', brand.id] });
      toast({ tone: 'success', message: t('ticketing:toast.prioritiesSaved') });
    },
    onError: (error: unknown) => {
      if (isFieldValidationError(error)) {
        setServerIssues(new Set(error.fields.map((field) => field.path)));
        setFailed(false);
        return;
      }
      setFailed(true);
    },
  });

  const duplicates = useMemo(
    () => (draft === null ? [] : duplicateIssues(draft, lastEdited)),
    [draft, lastEdited],
  );

  const defaultName = (priority: TicketPriority): string => t(`tickets:priority.${priority}`);
  const fieldId = (key: FieldKey): string => `${idBase}-${fieldPath(key)}`;

  // Focus follows a refused Save once the error text it points at is drawn.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target !== null) {
      pendingFocus.current = null;
      document.getElementById(fieldId(target))?.focus();
    }
  });

  if (stored === undefined || draft === null) {
    return <LoadingSkeleton />;
  }

  const invalidFormat = new Set(formatIssues(draft).map(fieldPath));
  const dirty = isDirty(draft, stored);
  const busy = save.isPending;

  const errorOf = (key: FieldKey): string | undefined => {
    const duplicate = duplicates.find((issue) => fieldPath(issue.key) === fieldPath(key));
    if (duplicate !== undefined) {
      return t('ticketing:priorities.duplicate', { name: defaultName(duplicate.takenBy) });
    }

    return serverIssues.has(fieldPath(key)) || invalidFormat.has(fieldPath(key))
      ? t('ticketing:priorities.invalid')
      : undefined;
  };

  const edit = (key: FieldKey, value: string): void => {
    setDraft(withField(draft, key, value));
    setLastEdited(key);
    setFailed(false);
    setServerIssues((current) => {
      if (!current.has(fieldPath(key))) {
        return current;
      }
      const next = new Set(current);
      next.delete(fieldPath(key));
      return next;
    });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const invalid = firstInvalid([
      ...duplicates.map((issue) => issue.key),
      ...formatIssues(draft),
      ...[...serverIssues].map((path) => {
        const [priority, language] = path.split('.');
        return { priority: priority as TicketPriority, locale: language as PriorityLabelLocale };
      }),
    ]);
    if (invalid !== undefined) {
      pendingFocus.current = invalid;
      redraw((count) => count + 1);
      return;
    }
    setFailed(false);
    save.mutate(draft);
  };

  const mutedHeader = {
    fontSize: 12,
    fontWeight: 500,
    color: tokens['text.secondary'],
    height: 'auto',
    paddingBlock: '10px',
    paddingInline: '12px',
    whiteSpace: 'nowrap' as const,
  };

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={t('ticketing:priorities.form')}
      sx={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('ticketing:priorities.intro')}
      </Typography>

      {failed ? <AlertBanner tone="danger">{t('ticketing:priorities.failed')}</AlertBanner> : null}

      <TableContainer
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
        }}
      >
        <Table role="table" sx={{ tableLayout: 'fixed', [NARROW]: { display: 'block' } }}>
          <colgroup>
            <col style={{ inlineSize: 180 }} />
            <col />
            <col />
            <col style={{ inlineSize: 56 }} />
          </colgroup>
          <TableHead
            role="rowgroup"
            sx={{
              backgroundColor: tokens['bg.muted'],
              [NARROW]: { ...visuallyHidden },
            }}
          >
            <TableRow role="row">
              <TableCell component="th" scope="col" role="columnheader" sx={mutedHeader}>
                {t('ticketing:priorities.columns.priority')}
              </TableCell>
              <TableCell component="th" scope="col" role="columnheader" sx={mutedHeader}>
                {t('ticketing:priorities.columns.en')}
              </TableCell>
              <TableCell component="th" scope="col" role="columnheader" sx={mutedHeader}>
                {t('ticketing:priorities.columns.ar')}
              </TableCell>
              <TableCell component="th" scope="col" role="columnheader" sx={mutedHeader}>
                <Box component="span" sx={visuallyHidden}>
                  {t('ticketing:priorities.columns.reset')}
                </Box>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody role="rowgroup" sx={{ [NARROW]: { display: 'block' } }}>
            {PRIORITY_KEYS.map((priority) => {
              const overridden = showsDefault(draft, priority, locale);

              return (
                <TableRow
                  key={priority}
                  role="row"
                  sx={{
                    verticalAlign: 'top',
                    [NARROW]: {
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) 40px',
                      columnGap: 2,
                      paddingBlock: 3,
                      paddingInline: 3,
                      borderBlockStart: `1px solid ${tokens['border.default']}`,
                      '&:first-of-type': { borderBlockStart: 0 },
                    },
                  }}
                >
                  <TableCell
                    component="th"
                    scope="row"
                    role="rowheader"
                    sx={{
                      height: 'auto',
                      verticalAlign: 'top',
                      fontWeight: 400,
                      paddingBlock: '10px',
                      paddingInline: '12px',
                      [NARROW]: {
                        display: 'block',
                        border: 0,
                        padding: 0,
                        gridColumn: 1,
                        gridRow: 1,
                      },
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                        alignItems: 'flex-start',
                        paddingBlockStart: '7px',
                        [NARROW]: { paddingBlockStart: 0 },
                      }}
                    >
                      <Pill tone={PRIORITY_TONE[priority]} solid={priority === 'urgent'}>
                        {pillName(draft, priority, locale)}
                      </Pill>
                      {overridden ? (
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {t('ticketing:priorities.defaultName', { name: defaultName(priority) })}
                        </Typography>
                      ) : null}
                    </Box>
                  </TableCell>

                  {LOCALES.map((language, index) => {
                    const key: FieldKey = { priority, locale: language };
                    const id = fieldId(key);
                    const error = errorOf(key);

                    return (
                      <TableCell
                        key={language}
                        role="cell"
                        sx={{
                          height: 'auto',
                          verticalAlign: 'top',
                          paddingBlock: '10px',
                          paddingInline: '12px',
                          [NARROW]: {
                            display: 'block',
                            border: 0,
                            padding: 0,
                            paddingBlockStart: 2,
                            gridColumn: '1 / -1',
                            gridRow: index + 2,
                          },
                        }}
                      >
                        <Typography
                          component="label"
                          htmlFor={id}
                          aria-hidden="true"
                          sx={{
                            display: 'none',
                            fontSize: 13,
                            fontWeight: 500,
                            marginBlockEnd: '6px',
                            [NARROW]: { display: 'block' },
                          }}
                        >
                          {t(`ticketing:priorities.columns.${language}`)}
                        </Typography>
                        <TextField
                          id={id}
                          size="small"
                          fullWidth
                          value={draft[priority][language]}
                          placeholder={t(`tickets:priority.${priority}`, { lng: language })}
                          error={error !== undefined}
                          disabled={busy}
                          onChange={(event) => {
                            edit(key, event.target.value);
                          }}
                          slotProps={{
                            htmlInput: {
                              lang: language,
                              dir: language === 'ar' ? 'rtl' : 'ltr',
                              maxLength: PRIORITY_LABEL_MAX_LENGTH,
                              'aria-label': t(
                                language === 'ar'
                                  ? 'ticketing:priorities.fieldAr'
                                  : 'ticketing:priorities.fieldEn',
                                { name: defaultName(priority) },
                              ),
                              'aria-invalid': error !== undefined,
                              'aria-describedby': error === undefined ? undefined : `${id}-error`,
                              style: { textAlign: 'start' },
                            },
                          }}
                        />
                        {error === undefined ? null : (
                          <Box
                            id={`${id}-error`}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              marginBlockStart: '6px',
                              fontSize: 12,
                              color: tokens['status.danger.text'],
                            }}
                          >
                            <CircleAlert size={12} aria-hidden="true" />
                            {error}
                          </Box>
                        )}
                      </TableCell>
                    );
                  })}

                  <TableCell
                    role="cell"
                    sx={{
                      height: 'auto',
                      verticalAlign: 'top',
                      paddingBlockStart: '12px',
                      paddingInline: '12px',
                      [NARROW]: {
                        display: 'block',
                        border: 0,
                        padding: 0,
                        gridColumn: 2,
                        gridRow: 1,
                        justifySelf: 'end',
                      },
                    }}
                  >
                    <IconButton
                      aria-label={t('ticketing:priorities.reset', { name: defaultName(priority) })}
                      disabled={busy || !hasOverride(draft, priority)}
                      onClick={() => {
                        setDraft(resetRow(draft, priority));
                        setServerIssues(new Set());
                        setFailed(false);
                      }}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('ticketing:priorities.hint')}
      </Typography>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button
          variant="outlined"
          disabled={!dirty || busy}
          onClick={() => {
            setDraft(draftOf(stored));
            setLastEdited(null);
            setServerIssues(new Set());
            setFailed(false);
          }}
        >
          {t('ticketing:priorities.discard')}
        </Button>
        <Button type="submit" variant="contained" disabled={!dirty || busy}>
          {t('ticketing:priorities.save')}
        </Button>
      </Box>
    </Box>
  );
}
