import type { WidgetAppearance, WidgetMode, WidgetSettings } from '@helpdock/schemas';
import {
  Box,
  Button,
  Radio,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { BookOpen, FileText, MessageCircle, Search } from 'lucide-react';
import { type FormEvent, type ReactNode, useId } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useChannelsApi } from '../../../../auth/session.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { SectionCard, useEmailAction } from '../section-card.tsx';
import { checkAccent } from './widget-draft.js';

const MODES: readonly { readonly mode: WidgetMode; readonly icon: typeof MessageCircle }[] = [
  { mode: 'chat', icon: MessageCircle },
  { mode: 'chat_articles', icon: Search },
  { mode: 'helpcenter', icon: BookOpen },
  { mode: 'form', icon: FileText },
];

/**
 * "Appearance" (M4-05, M4-06; artboard `AdminWidget`): the widget's mode, as
 * four radio cards (DESIGN §6.1 RadioCard), and its theme — the accent with
 * its contrast against white text, light or dark, the launcher's side and
 * what it shows, and the greeting in both languages. The draft is owned by
 * the tab, so the live preview beside this card draws what is being typed.
 */
export function AppearanceCard({
  brandId,
  draft,
  saved,
  onChange,
  onSaved,
}: {
  readonly brandId: string;
  readonly draft: WidgetAppearance;
  readonly saved: WidgetAppearance;
  readonly onChange: (next: WidgetAppearance) => void;
  readonly onSaved: (settings: WidgetSettings) => void;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const tokens = useSemanticTokens();
  const id = useId();
  const accent = checkAccent(draft.accent);

  const save = useEmailAction(
    (request: WidgetAppearance) => api.saveWidgetAppearance(brandId, request),
    t('channels:widget.appearance.saved'),
    onSaved,
  );

  const set = <K extends keyof WidgetAppearance>(key: K, value: WidgetAppearance[K]): void => {
    onChange({ ...draft, [key]: value });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (accent.kind === 'pass') {
      save.mutate({ ...draft, accent: draft.accent.trim() });
    }
  };

  const accentId = `${id}-accent`;
  const accentMessage =
    accent.kind === 'invalid'
      ? t('channels:widget.appearance.invalidColor')
      : accent.kind === 'pass'
        ? t('channels:widget.appearance.contrastPass', { ratio: accent.ratio.toFixed(1) })
        : t('channels:widget.appearance.contrastFail', { ratio: accent.ratio.toFixed(1) });

  return (
    <SectionCard
      id={`${id}-appearance`}
      heading={t('channels:widget.appearance.heading')}
      caption={t('channels:widget.appearance.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              onChange(saved);
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:widget.save')}
          </Button>
        </>
      }
    >
      <Box component="fieldset" sx={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
        <Typography component="legend" sx={{ fontSize: 14, fontWeight: 600, marginBlockEnd: 3 }}>
          {t('channels:widget.appearance.mode')}
        </Typography>
        <Box
          role="radiogroup"
          aria-label={t('channels:widget.appearance.mode')}
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 3,
          }}
        >
          {MODES.map(({ mode, icon: Icon }) => {
            const checked = draft.mode === mode;
            const inputId = `${id}-mode-${mode}`;
            return (
              <Box
                key={mode}
                component="label"
                htmlFor={inputId}
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: 3,
                  borderRadius: '6px',
                  border: `1px solid ${checked ? tokens['action.primary'] : tokens['border.strong']}`,
                  backgroundColor: checked ? tokens['action.primary.tint'] : tokens['bg.surface'],
                  cursor: 'pointer',
                }}
              >
                <Radio
                  id={inputId}
                  size="small"
                  checked={checked}
                  name={`${id}-mode`}
                  value={mode}
                  onChange={() => set('mode', mode)}
                  sx={{ padding: 0, marginBlockStart: '2px' }}
                  slotProps={{
                    input: { 'aria-describedby': `${inputId}-hint` },
                  }}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, fontWeight: 500 }}>
                    <Icon size={16} aria-hidden="true" />
                    {t(`channels:widget.appearance.modes.${mode}.label`)}
                  </Box>
                  <Typography
                    id={`${inputId}-hint`}
                    variant="caption"
                    sx={{ fontSize: 13, color: 'text.secondary' }}
                  >
                    {t(`channels:widget.appearance.modes.${mode}.hint`)}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box
        component="fieldset"
        sx={{
          margin: 0,
          padding: 0,
          paddingBlockStart: 5,
          border: 0,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          minWidth: 0,
        }}
      >
        <Typography component="legend" sx={{ fontSize: 14, fontWeight: 600, marginBlockEnd: 4 }}>
          {t('channels:widget.appearance.theme')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: '16px 20px',
          }}
        >
          <Field
            id={accentId}
            label={t('channels:widget.appearance.accent')}
            {...(accent.kind === 'pass' ? { hint: accentMessage } : { error: accentMessage })}
          >
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Box
                component="input"
                type="color"
                aria-label={t('channels:widget.appearance.pickAccent')}
                value={accent.kind === 'invalid' ? '#0f766e' : draft.accent.trim().toLowerCase()}
                onChange={(event) => set('accent', event.target.value.toUpperCase())}
                sx={{
                  width: 36,
                  height: 36,
                  padding: '2px',
                  borderRadius: '6px',
                  border: `1px solid ${tokens['border.strong']}`,
                  backgroundColor: tokens['bg.surface'],
                  flexShrink: 0,
                }}
              />
              <TextField
                id={accentId}
                size="small"
                value={draft.accent}
                error={accent.kind !== 'pass'}
                onChange={(event) => set('accent', event.target.value)}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    spellCheck: false,
                    'aria-invalid': accent.kind !== 'pass',
                    'aria-describedby': fieldDescribedBy(
                      accentId,
                      accent.kind === 'pass' ? { hint: accentMessage } : { error: accentMessage },
                    ),
                  },
                }}
                sx={{ flex: 1, '& input': { fontFamily: 'var(--hd-font-mono, monospace)' } }}
              />
            </Box>
          </Field>

          <Segmented
            label={t('channels:widget.appearance.scheme')}
            hint={t('channels:widget.appearance.schemeHint')}
            value={draft.colorScheme}
            options={(['light', 'dark', 'auto'] as const).map((value) => ({
              value,
              label: t(`channels:widget.appearance.schemes.${value}`),
            }))}
            onChange={(value) => set('colorScheme', value)}
          />
          <Segmented
            label={t('channels:widget.appearance.position')}
            hint={t('channels:widget.appearance.positionHint')}
            value={draft.position}
            options={(['end', 'start'] as const).map((value) => ({
              value,
              label: t(`channels:widget.appearance.positions.${value}`),
            }))}
            onChange={(value) => set('position', value)}
          />
          <Segmented
            label={t('channels:widget.appearance.launcher')}
            hint={t('channels:widget.appearance.launcherHint')}
            value={draft.launcher}
            options={(['icon', 'icon_text', 'text'] as const).map((value) => ({
              value,
              label: t(`channels:widget.appearance.launchers.${value}`),
            }))}
            onChange={(value) => set('launcher', value)}
          />
          <Field id={`${id}-greeting-en`} label={t('channels:widget.appearance.greetingEn')}>
            <TextField
              id={`${id}-greeting-en`}
              size="small"
              value={draft.greetingEn}
              onChange={(event) => set('greetingEn', event.target.value)}
              slotProps={{ htmlInput: { dir: 'auto', lang: 'en', maxLength: 280 } }}
            />
          </Field>
          <Field
            id={`${id}-greeting-ar`}
            label={t('channels:widget.appearance.greetingAr')}
            hint={t('channels:widget.appearance.greetingHint')}
          >
            <TextField
              id={`${id}-greeting-ar`}
              size="small"
              value={draft.greetingAr}
              onChange={(event) => set('greetingAr', event.target.value)}
              slotProps={{
                htmlInput: {
                  dir: 'rtl',
                  lang: 'ar',
                  maxLength: 280,
                  'aria-describedby': `${id}-greeting-ar-hint`,
                },
              }}
            />
          </Field>
        </Box>
      </Box>
    </SectionCard>
  );
}

/** DESIGN §6.1's SegmentedControl, labelled, with a hint under it. */
function Segmented<V extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: V;
  readonly options: readonly { readonly value: V; readonly label: string }[];
  readonly onChange: (value: V) => void;
}): ReactNode {
  const id = useId();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
      <Typography id={`${id}-label`} sx={{ fontSize: 13, fontWeight: 500 }}>
        {label}
      </Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={value}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        onChange={(_event, next: V | null) => {
          if (next !== null) {
            onChange(next);
          }
        }}
        sx={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}
      >
        {options.map((option) => (
          <ToggleButton key={option.value} value={option.value}>
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Typography id={`${id}-hint`} variant="caption" sx={{ color: 'text.secondary' }}>
        {hint}
      </Typography>
    </Box>
  );
}
