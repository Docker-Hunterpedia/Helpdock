import type { RetentionOverview, RetentionPreview } from '@helpdock/schemas';
import { RETENTION_MAX_DAYS } from '@helpdock/schemas';
import { Box, Button, MenuItem, Select, TextField, Typography } from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import {
  type DayField,
  type DraftField,
  draftFrom,
  invalidFields,
  isDirty,
  minimumFor,
  type RetentionDraft,
  requestFrom,
} from './retention-form.js';

/**
 * The Data retention card of `Admin/Brand · Danger zone` (M1-14,
 * DOMAIN-RULES §11), drawn as the artboard draws it: a three-column table —
 * what, how long, and how many rows the next run would take — and a footer
 * with the last run and the two actions.
 *
 * "Next purge" is the server's count under the **saved** windows, not the ones
 * being typed: the number is a promise about the database, and a count guessed
 * in the browser would be a promise the browser cannot keep. It refreshes on
 * save.
 */

const COLUMNS = 'minmax(0, 1.6fr) 180px 120px';

/** One row of the table: the label and hint, then the input, then the count. */
interface RowSpec {
  readonly field: DayField;
  readonly preview: keyof RetentionPreview;
  readonly label: string;
  readonly hint?: string;
  readonly unit: string;
}

export function RetentionCard({
  overview,
  busy,
  onSave,
}: {
  readonly overview: RetentionOverview;
  readonly busy: boolean;
  onSave(request: NonNullable<ReturnType<typeof requestFrom>>): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [draft, setDraft] = useState<RetentionDraft>(() => draftFrom(overview.settings));
  const [touched, setTouched] = useState(false);

  // The form re-fills when the saved settings change under it — after a save —
  // and not on every keystroke.
  useEffect(() => {
    setDraft(draftFrom(overview.settings));
    setTouched(false);
  }, [overview.settings]);

  const invalid = invalidFields(draft);
  const dirty = isDirty(draft, overview.settings);

  const update = (change: Partial<RetentionDraft>): void => {
    setDraft((current) => ({ ...current, ...change }));
    setTouched(true);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const request = requestFrom(draft);
    if (request !== undefined) {
      onSave(request);
    }
  };

  const rows: readonly RowSpec[] = [
    {
      field: 'spamTicketDays',
      preview: 'spamTickets',
      label: t('brand:retention.rows.spamTickets'),
      unit: t('brand:retention.days'),
    },
    {
      field: 'aiCallDays',
      preview: 'aiCalls',
      label: t('brand:retention.rows.aiCalls'),
      hint: t('brand:retention.rows.aiCallsHint'),
      unit: t('brand:retention.days'),
    },
    {
      field: 'searchLogDays',
      preview: 'searchLog',
      label: t('brand:retention.rows.searchLog'),
      unit: t('brand:retention.days'),
    },
    {
      field: 'auditLogDays',
      preview: 'auditLog',
      label: t('brand:retention.rows.auditLog'),
      hint: t('brand:retention.rows.auditLogHint'),
      unit: t('brand:retention.days'),
    },
    {
      field: 'visitorSessionDays',
      preview: 'visitorSessions',
      label: t('brand:retention.rows.visitorSessions'),
      hint: t('brand:retention.rows.visitorSessionsHint'),
      unit: t('brand:retention.daysInactive'),
    },
  ];

  const errorFor = (field: DraftField): string | undefined =>
    touched && invalid.includes(field)
      ? t('brand:retention.errors.days', { min: minimumFor(field), max: RETENTION_MAX_DAYS })
      : undefined;

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      aria-labelledby="retention-heading"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box
        sx={{
          paddingBlock: 4,
          paddingInline: 5,
          borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}
      >
        <Typography id="retention-heading" variant="h3" component="h2">
          {t('brand:retention.heading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('brand:retention.lead')}
        </Typography>
      </Box>

      <Box
        role="table"
        aria-labelledby="retention-heading"
        sx={{ paddingBlock: 2, paddingInline: 5 }}
      >
        <Box role="rowgroup">
          <Box
            role="row"
            sx={{
              display: 'grid',
              gridTemplateColumns: COLUMNS,
              gap: 3,
              alignItems: 'center',
              blockSize: 40,
              fontSize: 12,
              fontWeight: 500,
              color: 'text.secondary',
              borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
            }}
          >
            <Box role="columnheader">{t('brand:retention.columns.data')}</Box>
            <Box role="columnheader">{t('brand:retention.columns.keep')}</Box>
            <Box role="columnheader" sx={{ textAlign: 'end' }}>
              {t('brand:retention.columns.next')}
            </Box>
          </Box>
        </Box>

        <Box role="rowgroup">
          <Row
            label={t('brand:retention.rows.closedTickets')}
            hint={t('brand:retention.rows.closedTicketsHint')}
            count={overview.preview.closedTickets}
            error={draft.closedMode === 'days' ? errorFor('closedDays') : undefined}
          >
            <Box sx={{ display: 'flex', gap: '6px' }}>
              <Select
                size="small"
                value={draft.closedMode}
                onChange={(event) => {
                  update({ closedMode: event.target.value as RetentionDraft['closedMode'] });
                }}
                inputProps={{ 'aria-label': t('brand:retention.closedMode.label') }}
                sx={{ flexGrow: 1, fontSize: 13 }}
              >
                <MenuItem value="never">{t('brand:retention.closedMode.never')}</MenuItem>
                <MenuItem value="days">{t('brand:retention.closedMode.days')}</MenuItem>
              </Select>
              {draft.closedMode === 'days' ? (
                <DaysInput
                  value={draft.closedDays}
                  label={t('brand:retention.daysLabel', {
                    row: t('brand:retention.rows.closedTickets'),
                  })}
                  invalid={errorFor('closedDays') !== undefined}
                  width={64}
                  onChange={(closedDays) => {
                    update({ closedDays });
                  }}
                />
              ) : null}
            </Box>
          </Row>

          {rows.map((row, index) => (
            <Row
              key={row.field}
              label={row.label}
              hint={row.hint}
              count={overview.preview[row.preview]}
              error={errorFor(row.field)}
              last={index === rows.length - 1}
            >
              <Box sx={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <DaysInput
                  value={draft[row.field]}
                  label={t('brand:retention.daysLabel', { row: row.label })}
                  invalid={errorFor(row.field) !== undefined}
                  width={80}
                  onChange={(value) => {
                    update({ [row.field]: value });
                  }}
                />
                <Typography component="span" sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {row.unit}
                </Typography>
              </Box>
            </Row>
          ))}
        </Box>
      </Box>

      <Box
        sx={{
          paddingBlock: 3,
          paddingInline: 5,
          borderBlockStart: `1px solid ${tokens['bg.muted']}`,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          backgroundColor: tokens['bg.canvas'],
          borderEndStartRadius: '10px',
          borderEndEndRadius: '10px',
        }}
      >
        <LastRun overview={overview} />
        <Button
          type="button"
          variant="text"
          disabled={!dirty || busy}
          sx={{ marginInlineStart: 'auto' }}
          onClick={() => {
            setDraft(draftFrom(overview.settings));
            setTouched(false);
          }}
        >
          {t('brand:retention.discard')}
        </Button>
        <Button type="submit" variant="contained" disabled={!dirty || busy || invalid.length > 0}>
          {t('brand:retention.save')}
        </Button>
      </Box>
    </Box>
  );
}

function Row({
  label,
  hint,
  count,
  error,
  last = false,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly count: number | null;
  readonly error?: string | undefined;
  readonly last?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="row"
      sx={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        gap: 3,
        alignItems: 'center',
        minBlockSize: 52,
        paddingBlock: 1,
        borderBlockEnd: last ? 'none' : `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Box role="rowheader" sx={{ display: 'flex', flexDirection: 'column' }}>
        <Typography component="span" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        {hint === undefined ? null : (
          <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
            {hint}
          </Typography>
        )}
      </Box>
      <Box role="cell">
        {children}
        {error === undefined ? null : (
          <Typography
            role="alert"
            variant="caption"
            component="p"
            sx={{ color: tokens['status.danger.text'], marginBlockStart: 1 }}
          >
            {error}
          </Typography>
        )}
      </Box>
      <Typography
        role="cell"
        variant="mono"
        sx={{
          textAlign: 'end',
          fontSize: 12,
          color: count === null ? tokens['text.disabled'] : 'text.secondary',
        }}
      >
        {count === null ? (
          <span title={t('brand:retention.nothingToCount')}>
            <span aria-hidden="true">—</span>
            <Box component="span" sx={visuallyHidden}>
              {t('brand:retention.nothingToCount')}
            </Box>
          </span>
        ) : (
          t('brand:retention.rowCount', { count })
        )}
      </Typography>
    </Box>
  );
}

function DaysInput({
  value,
  label,
  invalid,
  width,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly width: number;
  onChange(value: string): void;
}): ReactNode {
  return (
    <TextField
      type="number"
      size="small"
      value={value}
      error={invalid}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      sx={{ inlineSize: width }}
      slotProps={{
        htmlInput: { min: 1, max: RETENTION_MAX_DAYS, 'aria-label': label, inputMode: 'numeric' },
      }}
    />
  );
}

function LastRun({ overview }: { readonly overview: RetentionOverview }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  const text =
    overview.lastRun === null
      ? t('brand:retention.neverRun')
      : t('brand:retention.lastRun', {
          time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(overview.lastRun.at),
          ),
          count: overview.lastRun.total,
        });

  return (
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
      {text}
    </Typography>
  );
}
