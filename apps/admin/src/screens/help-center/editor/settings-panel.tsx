import {
  HC_DESCRIPTION_MAX,
  HC_SLUG_MAX,
  type HcActivityEntry,
  type HcArticleStatus,
  type HcLocale,
  type HcVersion,
  type HcVisibility,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { Download, Globe, Lock, Upload } from 'lucide-react';
import { type ReactNode, useId, useRef } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { formatDay, formatStamp } from '../time.js';

/**
 * The editor's right panel (`Admin/HelpCenter-Editor`, DESIGN §6.3
 * ArticleSettingsPanel): Language, Status, Visibility, Address and search,
 * Markdown and Activity, one section each with a hairline between.
 */

export interface ScheduleDraft {
  readonly date: string;
  readonly time: string;
}

export interface SettingsPanelProps {
  readonly locale: HcLocale;
  readonly defaultLocale: HcLocale;
  readonly timezone: string;
  readonly versions: readonly HcVersion[];
  /** The version being edited; undefined while this language is not written yet. */
  readonly version: HcVersion | undefined;
  /** What the Status select shows, which is `scheduled` while a time is being chosen. */
  readonly status: HcArticleStatus;
  readonly schedule: ScheduleDraft;
  readonly scheduleError: string | undefined;
  readonly slug: string;
  readonly slugError: string | undefined;
  readonly description: string;
  readonly activity: readonly HcActivityEntry[];
  readonly editable: boolean;
  readonly busy: boolean;
  readonly auditLogLink: boolean;
  onLocale(locale: HcLocale): void;
  onStatus(status: HcArticleStatus): void;
  onSchedule(schedule: ScheduleDraft): void;
  onVisibility(visibility: HcVisibility): void;
  onSlug(slug: string): void;
  onSlugCommit(): void;
  onDescription(description: string): void;
  onImportMarkdown(file: File): void;
  onExportMarkdown(): void;
}

const LOCALES: readonly HcLocale[] = ['en', 'ar'];

export function SettingsPanel(props: SettingsPanelProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale: reader } = usePreferences();
  const statusId = useId();
  const dateId = useId();
  const timeId = useId();
  const slugId = useId();
  const descriptionId = useId();
  const visibilityId = useId();
  const markdown = useRef<HTMLInputElement>(null);
  const { version, editable } = props;
  const disabled = !editable || props.busy;

  const section = (heading: string, children: ReactNode, first = false) => (
    <Box
      component="section"
      sx={{
        paddingBlock: 3,
        paddingInline: 5,
        borderBlockStart: first ? 'none' : `1px solid ${tokens['bg.muted']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Typography component="h2" sx={{ fontSize: 14, lineHeight: '20px', fontWeight: 600 }}>
        {heading}
      </Typography>
      {children}
    </Box>
  );
  const caption = (text: string) => (
    <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
      {text}
    </Typography>
  );

  // The other language, when it exists and visitors cannot read it yet:
  // they are shown this one meanwhile (the artboard's "Arabic visitors get
  // English until Arabic is published").
  const waiting = props.versions.find(
    (row) => row.locale !== props.locale && row.status !== 'published',
  );
  const languageNote =
    version === undefined
      ? t('helpCenter:panel.language.missing', {
          language: t(`helpCenter:languages.${props.locale}`),
          fallback: t(`helpCenter:languages.${props.defaultLocale}`),
        })
      : props.locale === 'ar'
        ? t('helpCenter:panel.language.rtl')
        : waiting !== undefined && version.status === 'published'
          ? t('helpCenter:panel.language.fallback', {
              language: t(`helpCenter:languages.${waiting.locale}`),
              fallback: t(`helpCenter:languages.${props.locale}`),
            })
          : null;

  const statusNote =
    version?.publishedAt === null || version?.publishedAt === undefined
      ? null
      : t('helpCenter:panel.status.published', {
          when: formatDay(version.publishedAt, reader, props.timezone),
          who: version.publishedByName ?? t('helpCenter:panel.activity.system'),
        });

  return (
    <Box
      component="aside"
      aria-label={t('helpCenter:panel.label')}
      sx={{
        width: { xs: '100%', lg: 320 },
        flexShrink: 0,
        backgroundColor: tokens['bg.surface'],
        borderInlineStart: `1px solid ${tokens['border.default']}`,
        overflowY: 'auto',
      }}
    >
      {section(
        t('helpCenter:panel.language.heading'),
        <>
          <Box
            role="group"
            aria-label={t('helpCenter:panel.language.group')}
            sx={{ display: 'flex', gap: 2 }}
          >
            {LOCALES.map((candidate) => {
              const existing = props.versions.find((row) => row.locale === candidate);
              const pressed = candidate === props.locale;
              return (
                <Button
                  key={candidate}
                  variant="outlined"
                  aria-pressed={pressed}
                  onClick={() => {
                    props.onLocale(candidate);
                  }}
                  sx={{
                    flex: 1,
                    height: 'auto',
                    minHeight: 48,
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    paddingBlock: 1,
                    borderColor: pressed ? tokens['action.primary'] : tokens['border.strong'],
                    backgroundColor: pressed ? tokens['action.primary.tint'] : 'transparent',
                    color: 'text.primary',
                  }}
                >
                  <Box component="span" lang={candidate} sx={{ fontWeight: 500 }}>
                    {t(`helpCenter:languages.native.${candidate}`)}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      fontSize: 12,
                      lineHeight: '16px',
                      color: 'text.secondary',
                      fontWeight: 400,
                    }}
                  >
                    {existing === undefined
                      ? t('helpCenter:panel.language.notWritten')
                      : t(`helpCenter:status.${existing.status}`)}
                  </Box>
                </Button>
              );
            })}
          </Box>
          {languageNote === null ? null : caption(languageNote)}
        </>,
        true,
      )}

      {section(
        t('helpCenter:panel.status.heading'),
        <>
          <Box component="label" htmlFor={statusId} sx={visuallyHidden}>
            {t('helpCenter:panel.status.heading')}
          </Box>
          <Select
            size="small"
            value={props.status}
            disabled={disabled || version === undefined}
            onChange={(event) => {
              props.onStatus(event.target.value as HcArticleStatus);
            }}
            inputProps={{ id: statusId }}
            SelectDisplayProps={{ 'aria-label': t('helpCenter:panel.status.heading') }}
            sx={{ width: '100%' }}
          >
            {(['draft', 'published', 'scheduled', 'archived'] as const).map((status) => (
              <MenuItem key={status} value={status}>
                {t(`helpCenter:status.${status}`)}
              </MenuItem>
            ))}
          </Select>
          {props.status === 'scheduled' ? (
            <>
              <Box sx={{ display: 'flex', gap: 2 }}>
                <Field id={dateId} label={t('helpCenter:panel.status.date')}>
                  <TextField
                    id={dateId}
                    size="small"
                    type="date"
                    value={props.schedule.date}
                    disabled={disabled}
                    error={props.scheduleError !== undefined}
                    onChange={(event) => {
                      props.onSchedule({ ...props.schedule, date: event.target.value });
                    }}
                    slotProps={{ htmlInput: { dir: 'ltr' } }}
                  />
                </Field>
                <Field id={timeId} label={t('helpCenter:panel.status.time')}>
                  <TextField
                    id={timeId}
                    size="small"
                    type="time"
                    value={props.schedule.time}
                    disabled={disabled}
                    error={props.scheduleError !== undefined}
                    onChange={(event) => {
                      props.onSchedule({ ...props.schedule, time: event.target.value });
                    }}
                    slotProps={{ htmlInput: { dir: 'ltr' } }}
                  />
                </Field>
              </Box>
              {props.scheduleError === undefined ? (
                caption(t('helpCenter:panel.status.timezone', { zone: props.timezone }))
              ) : (
                <Typography
                  variant="caption"
                  role="alert"
                  sx={{ color: tokens['status.danger.text'] }}
                >
                  {props.scheduleError}
                </Typography>
              )}
            </>
          ) : statusNote === null ? null : (
            caption(statusNote)
          )}
        </>,
      )}

      {section(
        t('helpCenter:panel.visibility.heading'),
        <>
          <RadioGroup
            aria-labelledby={visibilityId}
            value={version?.visibility ?? 'public'}
            onChange={(event) => {
              props.onVisibility(event.target.value as HcVisibility);
            }}
          >
            <Box component="span" id={visibilityId} sx={visuallyHidden}>
              {t('helpCenter:panel.visibility.heading')}
            </Box>
            {(['public', 'internal'] as const).map((visibility) => {
              const Icon = visibility === 'public' ? Globe : Lock;
              return (
                <FormControlLabel
                  key={visibility}
                  value={visibility}
                  disabled={disabled || version === undefined}
                  control={<Radio size="small" />}
                  sx={{ marginInlineStart: 0, gap: 1 }}
                  label={
                    <Box
                      component="span"
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 13 }}
                    >
                      <Icon size={14} aria-hidden="true" />
                      {t(`helpCenter:panel.visibility.${visibility}`)}
                    </Box>
                  }
                />
              );
            })}
          </RadioGroup>
          {caption(t('helpCenter:panel.visibility.note'))}
        </>,
      )}

      {section(
        t('helpCenter:panel.address.heading'),
        <>
          <Field
            id={slugId}
            label={t('helpCenter:panel.address.slug')}
            error={props.slugError}
            hint={`/${props.locale}/articles/${props.slug}`}
          >
            <TextField
              id={slugId}
              size="small"
              value={props.slug}
              disabled={disabled}
              error={props.slugError !== undefined}
              onChange={(event) => {
                props.onSlug(event.target.value);
              }}
              onBlur={props.onSlugCommit}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  maxLength: HC_SLUG_MAX,
                  'aria-invalid': props.slugError !== undefined,
                  'aria-describedby': fieldDescribedBy(slugId, {
                    hint: `/${props.locale}/articles/${props.slug}`,
                    error: props.slugError,
                  }),
                  style: { fontFamily: '"IBM Plex Mono", monospace', fontSize: 13 },
                },
              }}
            />
          </Field>
          <Field
            id={descriptionId}
            label={t('helpCenter:panel.address.description')}
            action={
              <Typography variant="mono" component="span" sx={{ color: 'text.secondary' }}>
                {`${props.description.length} / ${HC_DESCRIPTION_MAX}`}
              </Typography>
            }
          >
            <TextField
              id={descriptionId}
              size="small"
              multiline
              minRows={2}
              value={props.description}
              disabled={disabled || version === undefined}
              onChange={(event) => {
                props.onDescription(event.target.value);
              }}
              slotProps={{
                htmlInput: {
                  maxLength: HC_DESCRIPTION_MAX,
                  lang: props.locale,
                  dir: props.locale === 'ar' ? 'rtl' : 'ltr',
                },
              }}
            />
          </Field>
        </>,
      )}

      {section(
        t('helpCenter:panel.markdown.heading'),
        <>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<Upload size={14} aria-hidden="true" />}
              disabled={disabled}
              onClick={() => markdown.current?.click()}
            >
              {t('helpCenter:panel.markdown.import')}
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<Download size={14} aria-hidden="true" />}
              disabled={version === undefined}
              onClick={props.onExportMarkdown}
            >
              {t('helpCenter:panel.markdown.export')}
            </Button>
          </Box>
          {caption(t('helpCenter:panel.markdown.note'))}
          <input
            ref={markdown}
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            tabIndex={-1}
            aria-hidden="true"
            style={visuallyHidden}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) {
                props.onImportMarkdown(file);
              }
            }}
          />
        </>,
      )}

      {section(
        t('helpCenter:panel.activity.heading'),
        <>
          <Box
            component="ul"
            sx={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            {props.activity.map((entry) => (
              <Box
                component="li"
                key={entry.id}
                sx={{ display: 'flex', gap: 2, fontSize: 12, lineHeight: '16px' }}
              >
                <Box component="span" sx={{ fontWeight: 500 }}>
                  {entry.action === 'scheduled' && entry.detail !== null
                    ? t('helpCenter:panel.activity.scheduledFor', {
                        when: formatStamp(entry.detail, reader, props.timezone),
                      })
                    : t(`helpCenter:panel.activity.actions.${entry.action}`)}
                  {entry.locale === null ? null : (
                    <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                      {` · ${entry.locale}`}
                    </Box>
                  )}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary', flexGrow: 1 }}>
                  {entry.actorName ?? t('helpCenter:panel.activity.system')}
                </Box>
                <Typography
                  variant="mono"
                  component="span"
                  sx={{ color: 'text.secondary', fontSize: 12 }}
                >
                  {formatStamp(entry.at, reader, props.timezone)}
                </Typography>
              </Box>
            ))}
          </Box>
          {props.auditLogLink ? (
            <Box
              component={Link}
              to={ROUTES.systemAuditLog}
              sx={{ fontSize: 12, color: tokens['text.link'] }}
            >
              {t('helpCenter:panel.activity.auditLog')}
            </Box>
          ) : null}
        </>,
      )}
    </Box>
  );
}
