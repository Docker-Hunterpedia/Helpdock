import type { DepartmentSummary, EmailOutgoingSettings, EmailSenders } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Plus, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useEmailApi } from '../../../auth/session.tsx';
import { Field } from '../../../ui/field.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { SectionCard, useEmailAction } from './section-card.tsx';
import { formatSender, parseReplyTo, parseSender } from './sender-format.js';

/**
 * "From and Reply-To per department" of `Admin/Channels · Outgoing email`: the
 * brand's default sender, a row per department that sends as someone else,
 * and "Add department" for one that does not yet.
 *
 * Each From is edited as one line, `Name <address>`, and read back by
 * `sender-format.ts`; a line that is not a sender marks its field and stops
 * the save, rather than sending something the api would refuse.
 */

interface SenderRow {
  readonly departmentId: string;
  from: string;
  replyTo: string;
}

interface SendersDraft {
  defaultFrom: string;
  rows: SenderRow[];
}

const draftOf = (senders: EmailSenders): SendersDraft => ({
  defaultFrom: formatSender(senders.defaultFrom),
  rows: senders.departments.map((row) => ({
    departmentId: row.departmentId,
    from: formatSender(row.from),
    replyTo: row.replyTo ?? '',
  })),
});

type Problems = ReadonlySet<string>;

/** The request a draft makes, or the fields that stop it (`default`, `from:<id>`, `replyTo:<id>`). */
export const sendersRequestOf = (
  draft: SendersDraft,
): { ok: true; request: EmailSenders } | { ok: false; problems: Problems } => {
  const problems = new Set<string>();
  const defaultFrom = draft.defaultFrom.trim() === '' ? null : parseSender(draft.defaultFrom);
  if (draft.defaultFrom.trim() !== '' && defaultFrom === null) {
    problems.add('default');
  }

  const departments = draft.rows.flatMap((row) => {
    const from = parseSender(row.from);
    const replyTo = parseReplyTo(row.replyTo);
    if (from === null) {
      problems.add(`from:${row.departmentId}`);
    }
    if (!replyTo.ok) {
      problems.add(`replyTo:${row.departmentId}`);
    }
    return from === null || !replyTo.ok
      ? []
      : [{ departmentId: row.departmentId, from, replyTo: replyTo.value }];
  });

  return problems.size === 0
    ? { ok: true, request: { defaultFrom, departments } }
    : { ok: false, problems };
};

export function SendersCard({
  brandId,
  settings,
  departments,
  onSaved,
}: {
  readonly brandId: string;
  readonly settings: EmailOutgoingSettings;
  readonly departments: readonly DepartmentSummary[];
  onSaved(settings: EmailOutgoingSettings): void;
}): ReactNode {
  const t = useT();
  const api = useEmailApi();
  const tokens = useSemanticTokens();
  const id = useId();
  const [draft, setDraft] = useState<SendersDraft>(() => draftOf(settings.senders));
  const [problems, setProblems] = useState<Problems>(new Set());
  const [adding, setAdding] = useState('');

  useEffect(() => {
    setDraft(draftOf(settings.senders));
  }, [settings.senders]);

  const save = useEmailAction(
    (request: EmailSenders) => api.saveSenders(brandId, request),
    t('channels:senders.saved'),
    onSaved,
  );

  const nameOf = (departmentId: string): string =>
    departments.find((row) => row.id === departmentId)?.name ?? departmentId;
  const unused = departments.filter(
    (department) => !draft.rows.some((row) => row.departmentId === department.id),
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const outcome = sendersRequestOf(draft);
    setProblems(outcome.ok ? new Set() : outcome.problems);
    if (outcome.ok) {
      save.mutate(outcome.request);
    }
  };

  const updateRow = (departmentId: string, patch: Partial<SenderRow>): void => {
    setDraft((held) => ({
      ...held,
      rows: held.rows.map((row) =>
        row.departmentId === departmentId ? { ...row, ...patch } : row,
      ),
    }));
  };

  return (
    <SectionCard
      id={`${id}-senders`}
      heading={t('channels:senders.heading')}
      caption={t('channels:senders.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(draftOf(settings.senders));
              setProblems(new Set());
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:senders.save')}
          </Button>
        </>
      }
    >
      <Field
        id={`${id}-default`}
        label={t('channels:senders.defaultLabel')}
        hint={t('channels:senders.defaultHint')}
        error={problems.has('default') ? t('channels:senders.invalid') : undefined}
      >
        <TextField
          id={`${id}-default`}
          size="small"
          value={draft.defaultFrom}
          error={problems.has('default')}
          onChange={(event) => {
            setDraft((held) => ({ ...held, defaultFrom: event.target.value }));
          }}
          slotProps={{ htmlInput: { dir: 'ltr', spellCheck: false } }}
        />
      </Field>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography id={`${id}-table`} sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('channels:senders.perDepartment')}
        </Typography>
        {draft.rows.length === 0 ? null : (
          <TableContainer
            sx={{ border: `1px solid ${tokens['border.default']}`, borderRadius: '6px' }}
          >
            <Table size="small" aria-labelledby={`${id}-table`}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell>{t('channels:senders.department')}</TableCell>
                  <TableCell>{t('channels:senders.from')}</TableCell>
                  <TableCell>{t('channels:senders.replyTo')}</TableCell>
                  <TableCell sx={{ width: 40 }}>
                    <Box component="span" sx={visuallyHidden}>
                      {t('channels:senders.actions')}
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {draft.rows.map((row) => {
                  const department = nameOf(row.departmentId);
                  const fromWrong = problems.has(`from:${row.departmentId}`);
                  const replyWrong = problems.has(`replyTo:${row.departmentId}`);
                  return (
                    <TableRow key={row.departmentId}>
                      <TableCell sx={{ fontWeight: 500 }}>{department}</TableCell>
                      <TableCell>
                        <TextField
                          size="small"
                          fullWidth
                          value={row.from}
                          error={fromWrong}
                          helperText={fromWrong ? t('channels:senders.invalid') : undefined}
                          onChange={(event) => {
                            updateRow(row.departmentId, { from: event.target.value });
                          }}
                          slotProps={{
                            htmlInput: {
                              'aria-label': t('channels:senders.fromFor', { department }),
                              dir: 'ltr',
                              spellCheck: false,
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <TextField
                          size="small"
                          fullWidth
                          type="email"
                          value={row.replyTo}
                          error={replyWrong}
                          helperText={replyWrong ? t('channels:senders.replyToInvalid') : undefined}
                          onChange={(event) => {
                            updateRow(row.departmentId, { replyTo: event.target.value });
                          }}
                          slotProps={{
                            htmlInput: {
                              'aria-label': t('channels:senders.replyToFor', { department }),
                              dir: 'ltr',
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <IconButton
                          size="small"
                          aria-label={t('channels:senders.remove', { department })}
                          onClick={() => {
                            setDraft((held) => ({
                              ...held,
                              rows: held.rows.filter(
                                (candidate) => candidate.departmentId !== row.departmentId,
                              ),
                            }));
                          }}
                        >
                          <X size={14} aria-hidden="true" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {unused.length === 0 ? null : (
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select
              size="small"
              value={adding}
              displayEmpty
              onChange={(event) => {
                setAdding(event.target.value);
              }}
              inputProps={{ 'aria-label': t('channels:senders.addLabel') }}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="" disabled>
                {t('channels:senders.addLabel')}
              </MenuItem>
              {unused.map((department) => (
                <MenuItem key={department.id} value={department.id}>
                  {department.name}
                </MenuItem>
              ))}
            </Select>
            <Button
              variant="outlined"
              startIcon={<Plus size={14} aria-hidden="true" />}
              disabled={adding === ''}
              onClick={() => {
                setDraft((held) => ({
                  ...held,
                  rows: [...held.rows, { departmentId: adding, from: '', replyTo: '' }],
                }));
                setAdding('');
              }}
            >
              {t('channels:senders.add')}
            </Button>
          </Box>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:senders.warning')}
        </Typography>
      </Box>
    </SectionCard>
  );
}
