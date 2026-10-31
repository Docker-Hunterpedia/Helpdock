import {
  type CannedPlaceholder,
  MACRO_BODY_MAX,
  MACRO_NAME_MAX_LENGTH,
  MACRO_SHORTCUT_MAX_LENGTH,
  type Macro,
  renderTemplate,
} from '@helpdock/schemas';
import { Box, Button, IconButton, MenuItem, Paper, TextField, Typography } from '@mui/material';
import { Copy, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { type ActionChoices, MacroActionsField } from './macro-actions-field.tsx';
import {
  cleanShortcut,
  draftPlaceholderProblems,
  insertAt,
  type MacroDraft,
  problemOf,
  shortcutProblem,
} from './macro-draft.js';
import { PlaceholderPicker } from './placeholder-picker.tsx';

/**
 * The end-side card of the Macros tab (artboard `AdminAutomationMacros`): name,
 * scope and department, the reply in English and Arabic with the placeholder
 * picker, a preview against sample values, and — for a macro — the actions.
 * "A canned response has the same editor without Actions."
 *
 * It holds a draft of its own and reports it whole on save, as the other
 * settings editors do; the tab turns it into a request, and mounts a fresh
 * editor (`key`) for each item it opens, so a half-edited draft never leaks
 * from one item into the next.
 */

type Locale = 'en' | 'ar';

export interface MacroEditorProps {
  readonly draft: MacroDraft;
  /** The saved item, or null for one not saved yet. */
  readonly macro: Macro | null;
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  readonly choices: ActionChoices;
  /** What each placeholder becomes in the picker and the preview. */
  readonly samples: ReadonlyMap<string, string>;
  /** "Edited by Omar Nasser · Sep 24", when there is somebody to name. */
  readonly editedBy: string | null;
  readonly busy: boolean;
  /** M14-14: the shortcut the api last refused as taken, so the field can say so until it changes. */
  readonly takenShortcut?: string | null | undefined;
  onDepartmentChange(departmentId: string): void;
  onSubmit(draft: MacroDraft): void;
  onDiscard(): void;
  onDuplicate?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}

export function MacroEditor({
  draft: initial,
  macro,
  departments,
  choices,
  samples,
  editedBy,
  busy,
  takenShortcut = null,
  onDepartmentChange,
  onSubmit,
  onDiscard,
  onDuplicate,
  onDelete,
}: MacroEditorProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const headingId = useId();
  const nameId = useId();
  const scopeId = useId();
  const shortcutId = useId();
  const problemsId = useId();
  const departmentId = useId();
  const [draft, setDraft] = useState(initial);
  const [picking, setPicking] = useState<Locale | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const areas = {
    en: useRef<HTMLTextAreaElement | null>(null),
    ar: useRef<HTMLTextAreaElement | null>(null),
  };

  const readOnly = macro !== null && !macro.canEdit;
  const isMacro = draft.kind === 'macro';
  const change = (patch: Partial<MacroDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
  };

  const insert = (target: Locale, name: CannedPlaceholder): void => {
    const area = areas[target].current;
    const selection = area === null ? null : { start: area.selectionStart, end: area.selectionEnd };
    const { text, caret } = insertAt(draft[target], `{{${name}}}`, selection);
    change({ [target]: text });
    setPicking(null);
    // After React has written the new value, the caret goes after the token.
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = problemOf(draft);
    setProblem(found === null ? null : t(`macros:editor.problems.${found}`));
    if (found === null) {
      onSubmit(draft);
    }
  };

  const placeholderIssues = draftPlaceholderProblems(draft);
  const shortcutWord = cleanShortcut(draft.shortcut).toLowerCase();
  const shortcutError = shortcutProblem(draft.shortcut)
    ? t('macros:editor.problems.shortcutInvalid')
    : takenShortcut !== null && shortcutWord === takenShortcut
      ? t('macros:editor.problems.shortcutTaken')
      : null;

  const previewLocale: Locale = locale === 'ar' && draft.ar.trim() !== '' ? 'ar' : 'en';
  const preview = renderTemplate(draft[previewLocale], samples).text;

  const reply = (target: Locale): ReactNode => {
    const id = `${nameId}-${target}`;
    const open = picking === target;

    return (
      <Box sx={{ display: 'grid', gap: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
          <Typography component="label" htmlFor={id} sx={{ fontSize: 13, fontWeight: 500 }}>
            {t(`macros:editor.reply.${target}`)}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t(`macros:editor.reply.${target}Caption`)}
          </Typography>
          <Button
            size="small"
            variant="text"
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={readOnly}
            onClick={() => {
              setPicking(open ? null : target);
            }}
            sx={{ marginInlineStart: 'auto' }}
          >
            {t('macros:editor.placeholders.open')}
          </Button>
        </Box>
        <TextField
          id={id}
          inputRef={areas[target]}
          multiline
          minRows={6}
          value={draft[target]}
          disabled={readOnly}
          error={placeholderIssues.some((issue) => issue.locale === target)}
          onChange={(event) => {
            change({ [target]: event.target.value });
          }}
          slotProps={{
            htmlInput: {
              maxLength: MACRO_BODY_MAX,
              ...(placeholderIssues.some((issue) => issue.locale === target)
                ? { 'aria-invalid': true, 'aria-describedby': problemsId }
                : {}),
              ...(target === 'ar' ? { lang: 'ar', dir: 'rtl' } : { dir: 'auto' }),
            },
          }}
        />
        {open ? (
          <PlaceholderPicker
            samples={samples}
            onPick={(name) => {
              insert(target, name);
            }}
            onClose={() => {
              setPicking(null);
              areas[target].current?.focus();
            }}
          />
        ) : null}
      </Box>
    );
  };

  return (
    <Paper
      component="form"
      aria-labelledby={headingId}
      onSubmit={submit}
      sx={{
        padding: 5,
        display: 'grid',
        gap: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        boxShadow: 'none',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography id={headingId} variant="h2" sx={{ fontWeight: 600 }}>
          {macro?.name ?? t(`macros:editor.new.${draft.kind}`)}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            backgroundColor: tokens['bg.muted'],
            color: 'text.secondary',
            borderRadius: '6px',
            paddingInline: 2,
          }}
        >
          {t(`macros:kind.${draft.kind}`)}
        </Typography>
        {editedBy === null ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {editedBy}
          </Typography>
        )}
        <Box sx={{ marginInlineStart: 'auto', display: 'flex', gap: 1 }}>
          {onDuplicate === undefined ? null : (
            <Button
              size="small"
              variant="outlined"
              startIcon={<Copy size={14} aria-hidden="true" />}
              onClick={onDuplicate}
              disabled={busy}
            >
              {t('macros:editor.duplicate')}
            </Button>
          )}
          {onDelete === undefined || readOnly ? null : (
            <IconButton
              size="small"
              aria-label={t('macros:editor.delete', { name: macro?.name ?? '' })}
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2 size={16} aria-hidden="true" />
            </IconButton>
          )}
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: '2fr 1fr 1fr' } }}>
        <Field id={nameId} label={`${t('macros:editor.name')} ${t('macros:editor.required')}`}>
          <TextField
            id={nameId}
            size="small"
            value={draft.name}
            disabled={readOnly}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
            slotProps={{ htmlInput: { maxLength: MACRO_NAME_MAX_LENGTH } }}
          />
        </Field>
        <Field id={scopeId} label={t('macros:editor.scope')}>
          <TextField
            id={scopeId}
            select
            size="small"
            value={draft.scope}
            disabled={readOnly}
            onChange={(event) => {
              const scope = event.target.value === 'personal' ? 'personal' : 'shared';
              change({ scope, departmentId: scope === 'personal' ? '' : draft.departmentId });
            }}
            slotProps={{ htmlInput: { 'aria-label': t('macros:editor.scope') } }}
          >
            <MenuItem value="shared">{t('macros:scope.shared')}</MenuItem>
            <MenuItem value="personal">{t('macros:scope.personalOnlyMe')}</MenuItem>
          </TextField>
        </Field>
        <Field id={departmentId} label={t('macros:editor.department')}>
          <TextField
            id={departmentId}
            select
            size="small"
            value={draft.departmentId}
            disabled={readOnly || draft.scope === 'personal'}
            onChange={(event) => {
              change({ departmentId: event.target.value, actions: draft.actions });
              onDepartmentChange(event.target.value);
            }}
            slotProps={{
              select: { displayEmpty: true },
              htmlInput: { 'aria-label': t('macros:editor.department') },
            }}
          >
            <MenuItem value="">{t('macros:editor.allDepartments')}</MenuItem>
            {departments.map((department) => (
              <MenuItem key={department.id} value={department.id}>
                {department.name}
              </MenuItem>
            ))}
          </TextField>
        </Field>
        <Field
          id={shortcutId}
          label={t('macros:editor.shortcut.label')}
          hint={shortcutError === null ? t('macros:editor.shortcut.hint') : undefined}
          error={shortcutError ?? undefined}
        >
          <TextField
            id={shortcutId}
            size="small"
            value={draft.shortcut}
            disabled={readOnly}
            error={shortcutError !== null}
            onChange={(event) => {
              change({ shortcut: event.target.value });
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <Box
                    component="span"
                    aria-hidden="true"
                    sx={{ color: 'text.secondary', marginInlineEnd: 0.5 }}
                  >
                    /
                  </Box>
                ),
              },
              htmlInput: {
                maxLength: MACRO_SHORTCUT_MAX_LENGTH + 1,
                dir: 'ltr',
                'aria-describedby': fieldDescribedBy(shortcutId, {
                  hint: t('macros:editor.shortcut.hint'),
                  error: shortcutError ?? undefined,
                }),
                autoCapitalize: 'none',
                spellCheck: false,
              },
            }}
          />
        </Field>
        <Typography variant="caption" sx={{ color: 'text.secondary', gridColumn: '1 / -1' }}>
          {t('macros:editor.scopeNote')}
        </Typography>
      </Box>

      <Box
        component="section"
        aria-labelledby={`${headingId}-reply`}
        sx={{ display: 'grid', gap: 3 }}
      >
        <Box>
          <Typography id={`${headingId}-reply`} variant="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
            {t('macros:editor.reply.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t(isMacro ? 'macros:editor.reply.captionMacro' : 'macros:editor.reply.caption')}
          </Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
          {reply('en')}
          {reply('ar')}
        </Box>
        {placeholderIssues.length === 0 ? null : (
          <Box id={problemsId} role="alert">
            <Box
              component="ul"
              sx={{
                margin: 0,
                paddingInlineStart: 5,
                color: tokens['status.danger.text'],
                fontSize: 13,
              }}
            >
              {placeholderIssues.map(({ locale: language, problem }) => (
                <li key={`${language}-${problem.kind}-${problem.text}`}>
                  {problem.kind === 'unknown'
                    ? t('macros:editor.placeholderErrors.unknown', { text: problem.text })
                    : t('macros:editor.placeholderErrors.unclosed', { text: problem.text })}
                  {problem.kind === 'unknown' && problem.suggestion !== null
                    ? ` ${t('macros:editor.placeholderErrors.didYouMean', { name: `{{${problem.suggestion}}}` })}`
                    : null}
                </li>
              ))}
            </Box>
          </Box>
        )}
        {preview.trim() === '' ? null : (
          <Box
            sx={{
              padding: 3,
              borderRadius: '6px',
              backgroundColor: tokens['bg.canvas'],
              border: `1px solid ${tokens['border.default']}`,
            }}
          >
            <Typography variant="body2" component="p">
              <strong>{t(`macros:editor.preview.${previewLocale}`)}</strong>{' '}
              <Box
                component="span"
                lang={previewLocale}
                dir={previewLocale === 'ar' ? 'rtl' : 'ltr'}
                sx={{ whiteSpace: 'pre-line' }}
              >
                {preview}
              </Box>
            </Typography>
          </Box>
        )}
      </Box>

      {isMacro ? (
        <MacroActionsField
          actions={draft.actions}
          choices={choices}
          disabled={readOnly}
          onChange={(actions) => {
            change({ actions });
          }}
        />
      ) : null}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography
          variant="caption"
          role={problem === null ? undefined : 'alert'}
          sx={{
            color: problem === null ? tokens['text.secondary'] : tokens['status.danger.text'],
            flex: 1,
          }}
        >
          {problem ?? (isMacro ? t('macros:editor.cannedNote') : '')}
        </Typography>
        <Button variant="text" onClick={onDiscard} disabled={busy}>
          {t('macros:editor.discard')}
        </Button>
        {readOnly ? null : (
          <Button type="submit" variant="contained" disabled={busy}>
            {t(macro === null ? 'macros:editor.create' : 'macros:editor.save')}
          </Button>
        )}
      </Box>
    </Paper>
  );
}
