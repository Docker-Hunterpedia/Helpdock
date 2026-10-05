import type { KnowledgeSourceList } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Globe, HardDrive, Lock, NotebookText, Upload, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useKnowledgeApi } from '../../../../knowledge/context.tsx';
import { leaveTo } from '../../../../knowledge/leave.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import {
  type AddKind,
  type AddProblem,
  type AddSourceDraft,
  type ChosenSchedule,
  createRequestOf,
  EMPTY_DRAFT,
  fileProblem,
} from './add-source-draft.js';
import { knowledgeFailure } from './knowledge-format.js';

/**
 * "Add knowledge source" of `Admin/AI-Knowledge`: the kind as four radio
 * cards, then that kind's form, then visibility (internal by default,
 * DOMAIN-RULES §5). Files go up one source per file through the presign and
 * confirm flow; a crawl starts at once; Notion and Drive are created and the
 * browser is sent to the provider to connect them.
 */

const KINDS: readonly { readonly kind: AddKind; readonly icon: typeof Upload }[] = [
  { kind: 'file', icon: Upload },
  { kind: 'crawl', icon: Globe },
  { kind: 'notion', icon: NotebookText },
  { kind: 'gdrive', icon: HardDrive },
];

export function AddSourceDialog({
  open,
  brandId,
  list,
  onClose,
  onAdded,
}: {
  readonly open: boolean;
  readonly brandId: string;
  readonly list: KnowledgeSourceList;
  onClose(): void;
  /** After the sources changed, with the sentence to say so. */
  onAdded(message: string): void;
}): ReactNode {
  const t = useT();
  const api = useKnowledgeApi();
  const id = useId();
  const [draft, setDraft] = useState<AddSourceDraft>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<readonly AddProblem[]>([]);

  const set = (patch: Partial<AddSourceDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
  };
  const close = (): void => {
    setDraft(EMPTY_DRAFT);
    setProblems([]);
    submit.reset();
    onClose();
  };

  const oauthReady =
    draft.kind === 'notion'
      ? list.oauth.notion
      : draft.kind === 'gdrive'
        ? list.oauth.gdrive
        : true;
  const usesToken = draft.kind === 'notion' && draft.token.trim() !== '';

  const submit = useMutation({
    mutationFn: async (): Promise<string | null> => {
      if (draft.kind === 'file') {
        for (const file of draft.files) {
          await api.uploadFile(brandId, file, draft.visibility);
        }
        return t('aiSettings:knowledge.addDialog.uploaded', { count: draft.files.length });
      }
      const outcome = createRequestOf(draft);
      if (!outcome.ok) {
        return null;
      }
      const created = await api.createSource(brandId, outcome.request);
      if ((draft.kind === 'notion' && !usesToken) || draft.kind === 'gdrive') {
        leaveTo(await api.oauthStart(brandId, created.id, draft.kind));
      }
      return t('aiSettings:knowledge.addDialog.added', { name: created.name });
    },
    onSuccess: (message) => {
      if (message !== null) {
        setDraft(EMPTY_DRAFT);
        onAdded(message);
      }
    },
  });

  const send = (event: FormEvent): void => {
    event.preventDefault();
    const found =
      draft.kind === 'file'
        ? [fileProblem(draft.files)].filter((problem): problem is AddProblem => problem !== null)
        : (() => {
            const outcome = createRequestOf(draft);
            return outcome.ok ? [] : outcome.problems;
          })();
    setProblems(found);
    if (found.length === 0) {
      submit.mutate();
    }
  };

  const problemText = (field: AddProblem['field']): string | undefined => {
    const problem = problems.find((candidate) => candidate.field === field);
    return problem === undefined
      ? undefined
      : t(`aiSettings:knowledge.addDialog.${problem.key}`, {
          name: 'name' in problem ? problem.name : '',
        });
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submit.isPending) {
          close();
        }
      }}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: {
          component: 'form',
          onSubmit: send,
          noValidate: true,
          sx: { borderRadius: '10px', maxWidth: 640 },
        } as object,
      }}
    >
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        <Box component="span" sx={{ flex: 1 }}>
          {t('aiSettings:knowledge.addDialog.title')}
        </Box>
        <IconButton
          aria-label={t('aiSettings:knowledge.drawer.close')}
          onClick={close}
          size="small"
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {submit.error === null ? null : (
          <AlertBanner tone="danger">{knowledgeFailure(t, submit.error)}</AlertBanner>
        )}

        <KindChoice
          name={`${id}-kind`}
          value={draft.kind}
          onChange={(kind) => {
            set({ kind });
            setProblems([]);
          }}
        />
        <Typography variant="caption" sx={{ color: 'text.secondary', marginBlockStart: -2 }}>
          {t('aiSettings:knowledge.addDialog.articlesNote')}
        </Typography>

        {draft.kind === 'file' ? (
          <Field
            id={`${id}-files`}
            label={t('aiSettings:knowledge.addDialog.files')}
            hint={t('aiSettings:knowledge.addDialog.filesHint')}
            error={problemText('files')}
          >
            <input
              id={`${id}-files`}
              type="file"
              multiple
              accept=".pdf,.docx,.md,.txt,application/pdf,text/markdown,text/plain"
              aria-describedby={fieldDescribedBy(`${id}-files`, {
                hint: t('aiSettings:knowledge.addDialog.filesHint'),
                error: problemText('files'),
              })}
              onChange={(event) => {
                set({ files: [...(event.target.files ?? [])] });
              }}
            />
          </Field>
        ) : null}

        {draft.kind === 'crawl' ? (
          <CrawlFields id={id} draft={draft} list={list} set={set} problemText={problemText} />
        ) : null}

        {draft.kind === 'notion' || draft.kind === 'gdrive' ? (
          <>
            {oauthReady || usesToken ? null : (
              <AlertBanner tone="warning">
                {t('aiSettings:knowledge.addDialog.oauthMissing')}
              </AlertBanner>
            )}
            <Box
              sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 3 }}
            >
              <Field
                id={`${id}-name`}
                label={t('aiSettings:knowledge.addDialog.name')}
                error={problemText('name')}
              >
                <TextField
                  id={`${id}-name`}
                  size="small"
                  value={draft.name}
                  error={problemText('name') !== undefined}
                  onChange={(event) => {
                    set({ name: event.target.value });
                  }}
                  slotProps={{ htmlInput: { maxLength: 200 } }}
                />
              </Field>
              <ScheduleField
                id={`${id}-schedule`}
                value={draft.schedule}
                onChange={(schedule) => set({ schedule })}
              />
            </Box>
            {draft.kind === 'notion' ? (
              <Field
                id={`${id}-token`}
                label={t('aiSettings:knowledge.addDialog.token')}
                hint={t('aiSettings:knowledge.addDialog.tokenHint')}
              >
                <TextField
                  id={`${id}-token`}
                  size="small"
                  type="password"
                  value={draft.token}
                  onChange={(event) => {
                    set({ token: event.target.value });
                  }}
                  slotProps={{
                    htmlInput: {
                      dir: 'ltr',
                      autoComplete: 'off',
                      'aria-describedby': `${id}-token-hint`,
                    },
                  }}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        <VisibilityChoice
          name={`${id}-visibility`}
          value={draft.visibility}
          onChange={(visibility) => {
            set({ visibility });
          }}
        />
      </DialogContent>
      <DialogActions sx={{ padding: 4, gap: 2 }}>
        <Button variant="text" onClick={close} disabled={submit.isPending}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          type="submit"
          variant="contained"
          loading={submit.isPending}
          disabled={!oauthReady && !usesToken}
        >
          {t(`aiSettings:knowledge.addDialog.submit.${draft.kind}`)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function KindChoice({
  name,
  value,
  onChange,
}: {
  readonly name: string;
  readonly value: AddKind;
  onChange(kind: AddKind): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box component="fieldset" sx={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <Typography component="legend" sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: '6px' }}>
        {t('aiSettings:knowledge.addDialog.type')}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
        {KINDS.map(({ kind, icon: Icon }) => {
          const checked = value === kind;
          return (
            <Box
              key={kind}
              component="label"
              sx={{
                display: 'flex',
                gap: 2,
                padding: 3,
                borderRadius: '6px',
                cursor: 'pointer',
                border: `1px solid ${checked ? tokens['action.primary'] : tokens['border.default']}`,
                backgroundColor: checked ? tokens['action.primary.tint'] : tokens['bg.surface'],
              }}
            >
              <Radio
                size="small"
                name={name}
                value={kind}
                checked={checked}
                onChange={() => {
                  onChange(kind);
                }}
                sx={{ padding: 0, alignSelf: 'flex-start' }}
              />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography
                  sx={{
                    fontSize: 13,
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1,
                  }}
                >
                  <Icon size={14} aria-hidden="true" />
                  {t(`aiSettings:knowledge.addDialog.types.${kind}.title`)}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {t(`aiSettings:knowledge.addDialog.types.${kind}.body`)}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function CrawlFields({
  id,
  draft,
  list,
  set,
  problemText,
}: {
  readonly id: string;
  readonly draft: AddSourceDraft;
  readonly list: KnowledgeSourceList;
  set(patch: Partial<AddSourceDraft>): void;
  problemText(field: AddProblem['field']): string | undefined;
}): ReactNode {
  const t = useT();
  const urlLabel =
    draft.mode === 'sitemap'
      ? t('aiSettings:knowledge.addDialog.sitemapUrl')
      : t('aiSettings:knowledge.addDialog.seedUrl');
  const urlHint = t('aiSettings:knowledge.addDialog.urlHint');
  const maxHint = t('aiSettings:knowledge.addDialog.maxPagesHint');

  const area = (field: 'include' | 'exclude') => (
    <Field
      id={`${id}-${field}`}
      label={t(`aiSettings:knowledge.addDialog.${field}`)}
      hint={t(`aiSettings:knowledge.addDialog.${field}Hint`)}
    >
      <TextField
        id={`${id}-${field}`}
        multiline
        minRows={2}
        size="small"
        value={draft[field]}
        onChange={(event) => {
          set({ [field]: event.target.value });
        }}
        slotProps={{
          htmlInput: {
            dir: 'ltr',
            spellCheck: false,
            'aria-describedby': `${id}-${field}-hint`,
            style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 },
          },
        }}
      />
    </Field>
  );

  return (
    <>
      <Box component="fieldset" sx={{ border: 0, margin: 0, padding: 0 }}>
        <Typography
          component="legend"
          sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: '6px' }}
        >
          {t('aiSettings:knowledge.addDialog.startFrom')}
        </Typography>
        <RadioGroup
          row
          value={draft.mode}
          onChange={(event) => {
            set({ mode: event.target.value === 'seed' ? 'seed' : 'sitemap' });
          }}
        >
          <FormControlLabel
            value="sitemap"
            control={<Radio size="small" />}
            label={t('aiSettings:knowledge.addDialog.sitemap')}
          />
          <FormControlLabel
            value="seed"
            control={<Radio size="small" />}
            label={t('aiSettings:knowledge.addDialog.seed')}
          />
        </RadioGroup>
      </Box>
      <Field id={`${id}-url`} label={urlLabel} hint={urlHint} error={problemText('url')}>
        <TextField
          id={`${id}-url`}
          size="small"
          value={draft.url}
          error={problemText('url') !== undefined}
          placeholder="https://docs.example.com/sitemap.xml"
          onChange={(event) => {
            set({ url: event.target.value });
          }}
          slotProps={{
            htmlInput: {
              dir: 'ltr',
              spellCheck: false,
              'aria-describedby': fieldDescribedBy(`${id}-url`, {
                hint: urlHint,
                error: problemText('url'),
              }),
            },
          }}
        />
      </Field>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 3 }}>
        <Field
          id={`${id}-max`}
          label={t('aiSettings:knowledge.addDialog.maxPages')}
          hint={maxHint}
          error={problemText('maxPages')}
        >
          <TextField
            id={`${id}-max`}
            size="small"
            value={draft.maxPages}
            error={problemText('maxPages') !== undefined}
            onChange={(event) => {
              set({ maxPages: event.target.value });
            }}
            slotProps={{
              htmlInput: {
                dir: 'ltr',
                inputMode: 'numeric',
                'aria-describedby': fieldDescribedBy(`${id}-max`, {
                  hint: maxHint,
                  error: problemText('maxPages'),
                }),
              },
            }}
          />
        </Field>
        <ScheduleField
          id={`${id}-schedule`}
          value={draft.schedule}
          onChange={(schedule) => set({ schedule })}
        />
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 3 }}>
        {area('include')}
        {area('exclude')}
      </Box>
      <Box>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={draft.render}
              disabled={!list.crawlRendering}
              onChange={(event) => {
                set({ render: event.target.checked });
              }}
            />
          }
          label={t('aiSettings:knowledge.addDialog.render')}
        />
        <Typography
          variant="caption"
          component="p"
          sx={{ color: 'text.secondary', paddingInlineStart: 7 }}
        >
          {list.crawlRendering
            ? t('aiSettings:knowledge.addDialog.renderHint')
            : t('aiSettings:knowledge.addDialog.renderOff')}
        </Typography>
      </Box>
    </>
  );
}

function ScheduleField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: ChosenSchedule;
  onChange(value: ChosenSchedule): void;
}): ReactNode {
  const t = useT();
  return (
    <Field
      id={id}
      label={t('aiSettings:knowledge.addDialog.scheduleLabel')}
      hint={t('aiSettings:knowledge.addDialog.scheduleHint')}
    >
      <Select
        id={id}
        size="small"
        value={value}
        onChange={(event) => {
          onChange(event.target.value as ChosenSchedule);
        }}
        inputProps={{ 'aria-label': t('aiSettings:knowledge.addDialog.scheduleLabel') }}
      >
        {(['daily', 'weekly', 'manual'] as const).map((schedule) => (
          <MenuItem key={schedule} value={schedule}>
            {t(`aiSettings:knowledge.addDialog.schedules.${schedule}`)}
          </MenuItem>
        ))}
      </Select>
    </Field>
  );
}

export function VisibilityChoice({
  name,
  value,
  onChange,
}: {
  readonly name: string;
  readonly value: 'public' | 'internal';
  onChange(value: 'public' | 'internal'): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  return (
    <Box
      component="fieldset"
      sx={{
        border: `1px solid ${tokens['border.default']}`,
        borderRadius: '6px',
        margin: 0,
        paddingInline: 4,
        paddingBlock: 3,
      }}
    >
      <Typography component="legend" sx={{ fontSize: 13, fontWeight: 600, paddingInline: 1 }}>
        {t('aiSettings:knowledge.addDialog.visibility')}
      </Typography>
      <RadioGroup
        name={name}
        value={value}
        onChange={(event) => {
          onChange(event.target.value === 'public' ? 'public' : 'internal');
        }}
      >
        {(['internal', 'public'] as const).map((option) => {
          const Icon = option === 'public' ? Globe : Lock;
          return (
            <FormControlLabel
              key={option}
              value={option}
              control={<Radio size="small" />}
              sx={{ alignItems: 'flex-start', marginBlock: 1 }}
              label={
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  <Typography
                    sx={{
                      fontSize: 13,
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 1,
                    }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {t(`aiSettings:knowledge.addDialog.${option}.title`)}
                    {option === 'internal' ? (
                      <Box component="span" sx={{ fontWeight: 400, color: 'text.secondary' }}>
                        {t('aiSettings:knowledge.addDialog.internal.default')}
                      </Box>
                    ) : null}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t(`aiSettings:knowledge.addDialog.${option}.body`)}
                  </Typography>
                </Box>
              }
            />
          );
        })}
      </RadioGroup>
    </Box>
  );
}
