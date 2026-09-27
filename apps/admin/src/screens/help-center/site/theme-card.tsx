import {
  HC_IMAGE_MIME_TYPES,
  HC_SURFACE_TONES,
  HC_THEME_FONTS,
  HC_THEME_MODES,
  type HcAppearance,
  type HcMediaPurpose,
  type HcSiteImage,
  type HcTheme,
} from '@helpdock/schemas';
import { Box, Button, MenuItem, Select, TextField, Typography } from '@mui/material';
import { ImageUp } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { SectionCard } from '../../admin/channels/section-card.tsx';
import { Segmented } from '../../admin/channels/widget/appearance-card.tsx';
import { useHelpCenter, useHelpCenterReport } from '../use-help-center.js';
import { checkAccent, radiusOf } from './site-draft.js';
import { useSiteSave } from './use-site.js';

const IMAGE_POLL_MS = 500;
const IMAGE_POLL_TRIES = 40;

interface Draft {
  readonly theme: HcTheme;
  readonly radius: string;
  readonly logo: HcSiteImage | null;
  readonly favicon: HcSiteImage | null;
}

const draftOf = (appearance: HcAppearance): Draft => ({
  theme: appearance.theme,
  radius: String(appearance.theme.radius),
  logo: appearance.logo,
  favicon: appearance.favicon,
});

/**
 * "Theme" (M5-06, `Admin/HelpCenter-Settings`): the accent with the contrast
 * line DESIGN §8 asks for, the surface tone, the corner radius, light or dark,
 * the typeface pair, and the logo and favicon, uploaded through the article
 * image pipeline with the 512 px purpose.
 */
export function ThemeCard({
  appearance,
  canManage,
}: {
  readonly appearance: HcAppearance;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT();
  const id = useId();
  const { api } = useHelpCenter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(appearance));
  useEffect(() => {
    setDraft(draftOf(appearance));
  }, [appearance]);

  const save = useSiteSave(api.saveAppearance.bind(api), (site, result: HcAppearance) => ({
    ...site,
    appearance: result,
  }));

  const accent = checkAccent(draft.theme);
  const radius = radiusOf(draft.radius);
  const set = <K extends keyof HcTheme>(key: K, value: HcTheme[K]): void => {
    setDraft((current) => ({ ...current, theme: { ...current.theme, [key]: value } }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (accent.kind === 'pass' && radius !== null) {
      save.mutate({
        theme: { ...draft.theme, accent: draft.theme.accent.trim().toUpperCase(), radius },
        logoMediaId: draft.logo?.mediaId ?? null,
        faviconMediaId: draft.favicon?.mediaId ?? null,
      });
    }
  };

  const accentId = `${id}-accent`;
  const accentMessage =
    accent.kind === 'invalid'
      ? t('helpCenter:site.theme.invalidColor')
      : accent.kind === 'pass'
        ? t('helpCenter:site.theme.contrastPass', { ratio: accent.ratio.toFixed(1) })
        : t('helpCenter:site.theme.contrastFail', { ratio: accent.ratio.toFixed(1) });
  const radiusId = `${id}-radius`;
  const fontId = `${id}-font`;

  return (
    <SectionCard
      id={`${id}-theme`}
      heading={t('helpCenter:site.theme.heading')}
      caption={t('helpCenter:site.theme.caption')}
      onSubmit={submit}
      {...(canManage
        ? {
            footer: (
              <>
                <Button
                  variant="text"
                  disabled={save.isPending}
                  onClick={() => {
                    setDraft(draftOf(appearance));
                  }}
                >
                  {t('helpCenter:settings.discard')}
                </Button>
                <Button type="submit" variant="contained" disabled={save.isPending}>
                  {t('helpCenter:settings.save')}
                </Button>
              </>
            ),
          }
        : {})}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 5,
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <Field
            id={accentId}
            label={t('helpCenter:site.theme.accent')}
            {...(accent.kind === 'pass' ? { hint: accentMessage } : { error: accentMessage })}
          >
            <Box sx={{ display: 'flex', gap: 2 }}>
              <ColorSwatch
                value={
                  accent.kind === 'invalid' ? '#0f766e' : draft.theme.accent.trim().toLowerCase()
                }
                label={t('helpCenter:site.theme.pickAccent')}
                disabled={!canManage}
                onChange={(value) => set('accent', value.toUpperCase())}
              />
              <TextField
                id={accentId}
                size="small"
                value={draft.theme.accent}
                disabled={!canManage}
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
            label={t('helpCenter:site.theme.surfaceTone')}
            hint={t('helpCenter:site.theme.surfaceToneHint')}
            value={draft.theme.surfaceTone}
            options={HC_SURFACE_TONES.map((value) => ({
              value,
              label: t(`helpCenter:site.theme.tones.${value}`),
            }))}
            onChange={(value) => set('surfaceTone', value)}
          />
          <Field
            id={radiusId}
            label={t('helpCenter:site.theme.radius')}
            {...(radius === null
              ? { error: t('helpCenter:site.theme.radiusError') }
              : { hint: t('helpCenter:site.theme.radiusHint') })}
          >
            <TextField
              id={radiusId}
              size="small"
              value={draft.radius}
              disabled={!canManage}
              error={radius === null}
              onChange={(event) => {
                const text = event.target.value;
                setDraft((current) => ({ ...current, radius: text }));
              }}
              slotProps={{
                htmlInput: {
                  inputMode: 'numeric',
                  dir: 'ltr',
                  'aria-invalid': radius === null,
                  'aria-describedby': fieldDescribedBy(
                    radiusId,
                    radius === null
                      ? { error: t('helpCenter:site.theme.radiusError') }
                      : { hint: t('helpCenter:site.theme.radiusHint') },
                  ),
                },
              }}
              sx={{ maxWidth: 120 }}
            />
          </Field>
          <Segmented
            label={t('helpCenter:site.theme.mode')}
            hint={t('helpCenter:site.theme.modeHint')}
            value={draft.theme.mode}
            options={HC_THEME_MODES.map((value) => ({
              value,
              label: t(`helpCenter:site.theme.modes.${value}`),
            }))}
            onChange={(value) => set('mode', value)}
          />
          <Field
            id={fontId}
            label={t('helpCenter:site.theme.font')}
            hint={t('helpCenter:site.theme.fontHint')}
          >
            <Select
              size="small"
              value={draft.theme.font}
              disabled={!canManage}
              onChange={(event) => set('font', event.target.value as HcTheme['font'])}
              inputProps={{ id: fontId }}
              SelectDisplayProps={{
                'aria-label': t('helpCenter:site.theme.font'),
                'aria-describedby': `${fontId}-hint`,
              }}
            >
              {HC_THEME_FONTS.map((font) => (
                <MenuItem key={font} value={font}>
                  {t(`helpCenter:site.theme.fonts.${font}`)}
                </MenuItem>
              ))}
            </Select>
          </Field>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <ImageRow
            label={t('helpCenter:site.theme.logo')}
            purpose="logo"
            image={draft.logo}
            canManage={canManage}
            onChange={(image) => {
              setDraft((current) => ({ ...current, logo: image }));
            }}
          />
          <ImageRow
            label={t('helpCenter:site.theme.favicon')}
            purpose="favicon"
            image={draft.favicon}
            canManage={canManage}
            onChange={(image) => {
              setDraft((current) => ({ ...current, favicon: image }));
            }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('helpCenter:site.theme.imageHint')}
          </Typography>
        </Box>
      </Box>
    </SectionCard>
  );
}

function ColorSwatch({
  value,
  label,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const tokens = useSemanticTokens();
  return (
    <Box
      component="input"
      type="color"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      sx={{
        width: 40,
        height: 40,
        padding: '2px',
        borderRadius: '6px',
        border: `1px solid ${tokens['border.strong']}`,
        backgroundColor: tokens['bg.surface'],
        flexShrink: 0,
      }}
    />
  );
}

/** One uploaded image: a preview tile, its size, Upload or Replace, and Remove. */
function ImageRow({
  label,
  purpose,
  image,
  canManage,
  onChange,
}: {
  readonly label: string;
  readonly purpose: Exclude<HcMediaPurpose, 'article'>;
  readonly image: HcSiteImage | null;
  readonly canManage: boolean;
  readonly onChange: (image: HcSiteImage | null) => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const report = useHelpCenterReport();
  const { brand, api } = useHelpCenter();
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const input = useRef<HTMLInputElement>(null);
  const action =
    image === null ? t('helpCenter:site.theme.upload') : t('helpCenter:site.theme.replace');

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const presigned = await api.presignImage(brand.id, {
        fileName: file.name,
        mime: file.type as (typeof HC_IMAGE_MIME_TYPES)[number],
        size: file.size,
        purpose,
      });
      await api.uploadImage(presigned, file);
      let media = await api.confirmImage(brand.id, presigned.mediaId);
      for (let tries = 0; media.status === 'processing' && tries < IMAGE_POLL_TRIES; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_MS));
        media = await api.image(brand.id, presigned.mediaId);
      }
      if (media.status !== 'ready' || media.src === null) {
        toast({ tone: 'danger', message: t('helpCenter:site.theme.imageRejected') });
        return;
      }
      onChange({ mediaId: media.id, src: media.src, width: media.width, height: media.height });
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      role="group"
      aria-labelledby={labelId}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        padding: 3,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        flexWrap: 'wrap',
      }}
    >
      <Box
        sx={{
          width: 48,
          height: 48,
          borderRadius: '6px',
          backgroundColor: tokens['bg.muted'],
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {image === null ? null : (
          <Box component="img" src={image.src} alt="" sx={{ maxWidth: 48, maxHeight: 48 }} />
        )}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: '1 1 120px', minWidth: 0 }}>
        <Typography id={labelId} sx={{ fontSize: 14, fontWeight: 500 }}>
          {label}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {busy
            ? t('helpCenter:site.theme.uploading')
            : image === null
              ? t('helpCenter:site.theme.none')
              : image.width === null || image.height === null
                ? ''
                : t('helpCenter:site.theme.imageSize', {
                    width: image.width,
                    height: image.height,
                  })}
        </Typography>
      </Box>
      {canManage ? (
        <>
          <Box
            component="input"
            ref={input}
            type="file"
            hidden
            accept={HC_IMAGE_MIME_TYPES.join(',')}
            aria-label={`${label}: ${action}`}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) {
                void upload(file);
              }
            }}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={busy}
            aria-label={`${label}: ${action}`}
            startIcon={<ImageUp size={16} aria-hidden="true" />}
            onClick={() => input.current?.click()}
          >
            {action}
          </Button>
          {image === null ? null : (
            <Button size="small" variant="text" disabled={busy} onClick={() => onChange(null)}>
              {t('helpCenter:site.theme.remove')}
            </Button>
          )}
        </>
      ) : null}
    </Box>
  );
}
