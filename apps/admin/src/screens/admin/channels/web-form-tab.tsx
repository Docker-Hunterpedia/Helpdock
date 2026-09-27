import {
  WEB_FORM_REFERENCE_PLACEHOLDER,
  type WebFormField,
  type WebFormSettings,
  type WebFormSettingsUpdate,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  IconButton,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Copy, ExternalLink, GripVertical } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import {
  currentBrand,
  useChannelsApi,
  useSession,
  useTicketingApi,
} from '../../../auth/session.tsx';
import { channelsKeys } from '../../../channels/api.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { moveBy } from '../ticketing/reorder.js';
import { SectionCard, useEmailAction } from './section-card.tsx';

/**
 * Channels › Web form (M4-09, artboard `AdminWebForm`): the hosted form, and
 * what happens after a customer sends it.
 *
 * The two cards are two forms with a Save each, as on Outgoing email, and both
 * send the whole settings object: each fills its own half from its draft and
 * the other half from what is stored, so saving one never saves what somebody
 * is still deciding in the other.
 */

/** The stored settings as the request that would save them unchanged. */
export const updateFrom = (settings: WebFormSettings): WebFormSettingsUpdate => ({
  enabled: settings.enabled,
  departmentId: settings.departmentId,
  captchaEnabled: settings.captcha.enabled,
  thankYou: settings.thankYou,
  fields: settings.fields.map(({ field, shown, required }) => ({ field, shown, required })),
});

/** A field after its Shown box changed: hiding it also drops Required. */
export const withShown = (field: WebFormField, shown: boolean): WebFormField =>
  field.locked ? field : { ...field, shown, required: shown && field.required };

export function WebFormTab(): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: channelsKeys.webForm(brand.id),
    queryFn: () => api.webForm(brand.id),
  });
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
  });

  // What `{{ticket.number}}` looks like for this brand, in the hint and the preview.
  const sample = `${brand.ticketPrefix}-1043`;

  const saved = (next: WebFormSettings): void => {
    queryClient.setQueryData(channelsKeys.webForm(brand.id), next);
  };

  if (settings.isError) {
    return <AlertBanner tone="danger">{t('channels:webForm.loadFailed')}</AlertBanner>;
  }
  if (settings.data === undefined) {
    return <Box aria-busy="true" />;
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <HostedFormCard brandId={brand.id} settings={settings.data} onSaved={saved} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <AfterSentCard
          brandId={brand.id}
          settings={settings.data}
          departments={departments.data?.departments ?? []}
          sample={sample}
          onSaved={saved}
        />
        <PreviewCard thankYou={settings.data.thankYou} reference={sample} />
      </Box>
    </Box>
  );
}

function HostedFormCard({
  brandId,
  settings,
  onSaved,
}: {
  readonly brandId: string;
  readonly settings: WebFormSettings;
  onSaved(settings: WebFormSettings): void;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const id = useId();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [fields, setFields] = useState<readonly WebFormField[]>(settings.fields);

  useEffect(() => {
    setEnabled(settings.enabled);
    setFields(settings.fields);
  }, [settings]);

  const save = useEmailAction(
    (request: WebFormSettingsUpdate) => api.saveWebForm(brandId, request),
    t('channels:webForm.saved'),
    onSaved,
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate({
      ...updateFrom(settings),
      enabled,
      fields: fields.map(({ field, shown, required }) => ({ field, shown, required })),
    });
  };

  const change = (next: WebFormField): void => {
    setFields((held) => held.map((field) => (field.field === next.field ? next : field)));
  };
  const move = (field: string, offset: number): void => {
    setFields((held) => {
      const order = moveBy(
        held.map((entry) => entry.field),
        field,
        offset,
      );
      return order.flatMap((ref) => held.filter((entry) => entry.field === ref));
    });
  };
  const nameOf = (field: WebFormField): string =>
    field.kind === 'custom'
      ? field.label
      : t(
          `channels:webForm.fields.names.${field.field as 'name' | 'email' | 'subject' | 'message'}`,
        );

  const copy = (): void => {
    void navigator.clipboard.writeText(settings.publicUrl).then(
      () => {
        toast({ tone: 'success', message: t('channels:webForm.address.copied') });
      },
      () => {
        toast({ tone: 'danger', message: t('channels:actionFailed') });
      },
    );
  };

  return (
    <SectionCard
      id={`${id}-hosted`}
      heading={t('channels:webForm.hosted.heading')}
      caption={t('channels:webForm.hosted.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setEnabled(settings.enabled);
              setFields(settings.fields);
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:webForm.save')}
          </Button>
        </>
      }
    >
      <CheckRow
        id={`${id}-on`}
        checked={enabled}
        label={t('channels:webForm.enabled.label')}
        hint={t('channels:webForm.enabled.hint')}
        onChange={setEnabled}
      />

      <Field
        id={`${id}-url`}
        label={t('channels:webForm.address.label')}
        hint={t('channels:webForm.address.hint')}
      >
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={`${id}-url`}
            size="small"
            fullWidth
            value={settings.publicUrl}
            slotProps={{
              htmlInput: {
                readOnly: true,
                dir: 'ltr',
                'aria-describedby': fieldDescribedBy(`${id}-url`, {
                  hint: t('channels:webForm.address.hint'),
                }),
                style: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 },
              },
            }}
          />
          <IconButton
            aria-label={t('channels:webForm.address.copy')}
            onClick={copy}
            sx={{ border: `1px solid ${tokens['border.strong']}`, borderRadius: '6px' }}
          >
            <Copy size={16} aria-hidden="true" />
          </IconButton>
          <Button
            variant="outlined"
            href={settings.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            startIcon={<ExternalLink size={16} aria-hidden="true" />}
            sx={{ flexShrink: 0 }}
          >
            {t('channels:webForm.address.open')}
          </Button>
        </Box>
      </Field>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography id={`${id}-fields`} variant="bodyStrong" component="h3" sx={{ fontSize: 13 }}>
          {t('channels:webForm.fields.heading')}
        </Typography>
        <Table size="small" aria-labelledby={`${id}-fields`} aria-describedby={`${id}-fields-note`}>
          <TableHead>
            <TableRow sx={{ height: 32 }}>
              <TableCell sx={{ width: 40 }}>{t('channels:webForm.fields.order')}</TableCell>
              <TableCell>{t('channels:webForm.fields.field')}</TableCell>
              <TableCell sx={{ width: 96 }}>{t('channels:webForm.fields.type')}</TableCell>
              <TableCell sx={{ width: 64 }}>{t('channels:webForm.fields.shown')}</TableCell>
              <TableCell sx={{ width: 72 }}>{t('channels:webForm.fields.required')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {fields.map((field) => {
              const name = nameOf(field);
              return (
                <TableRow key={field.field} sx={{ height: 40 }}>
                  <TableCell>
                    <IconButton
                      size="small"
                      aria-label={t('channels:webForm.fields.reorder', { name })}
                      aria-describedby={`${id}-reorder-hint`}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          move(field.field, event.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                    >
                      <GripVertical size={16} aria-hidden="true" />
                    </IconButton>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {name}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {field.kind === 'custom'
                          ? t('channels:webForm.fields.custom')
                          : field.field === 'email'
                            ? t('channels:webForm.fields.builtInEmail')
                            : t('channels:webForm.fields.builtIn')}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>{t(`channels:webForm.fields.types.${field.type}`)}</TableCell>
                  <TableCell>
                    <Checkbox
                      size="small"
                      checked={field.shown}
                      disabled={field.locked}
                      onChange={(event) => {
                        change(withShown(field, event.target.checked));
                      }}
                      slotProps={{
                        input: { 'aria-label': t('channels:webForm.fields.show', { name }) },
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      size="small"
                      checked={field.required}
                      disabled={field.locked || !field.shown}
                      onChange={(event) => {
                        change({ ...field, required: event.target.checked });
                      }}
                      slotProps={{
                        input: { 'aria-label': t('channels:webForm.fields.require', { name }) },
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Typography id={`${id}-reorder-hint`} variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:webForm.fields.reorderHint')}
        </Typography>
        <Typography id={`${id}-fields-note`} variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:webForm.fields.note')}
        </Typography>
      </Box>
    </SectionCard>
  );
}

interface AfterDraft {
  departmentId: string | null;
  captchaEnabled: boolean;
  thankYouEn: string;
  thankYouAr: string;
}

const afterDraftOf = (settings: WebFormSettings): AfterDraft => ({
  departmentId: settings.departmentId,
  captchaEnabled: settings.captcha.enabled,
  thankYouEn: settings.thankYou.en,
  thankYouAr: settings.thankYou.ar,
});

/** The select's value for "the first department": MUI's Select wants a string. */
const FIRST_DEPARTMENT = '';

function AfterSentCard({
  brandId,
  settings,
  departments,
  sample,
  onSaved,
}: {
  readonly brandId: string;
  readonly settings: WebFormSettings;
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  readonly sample: string;
  onSaved(settings: WebFormSettings): void;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const id = useId();
  const [draft, setDraft] = useState<AfterDraft>(() => afterDraftOf(settings));
  const [emptyOne, setEmptyOne] = useState(false);

  useEffect(() => {
    setDraft(afterDraftOf(settings));
  }, [settings]);

  const save = useEmailAction(
    (request: WebFormSettingsUpdate) => api.saveWebForm(brandId, request),
    t('channels:webForm.saved'),
    onSaved,
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const en = draft.thankYouEn.trim();
    const ar = draft.thankYouAr.trim();
    setEmptyOne(en === '' || ar === '');
    if (en !== '' && ar !== '') {
      save.mutate({
        ...updateFrom(settings),
        departmentId: draft.departmentId,
        captchaEnabled: draft.captchaEnabled,
        thankYou: { en, ar },
      });
    }
  };

  const first = departments[0]?.name ?? '';
  const empty = t('channels:webForm.thankYou.empty');
  const enError = emptyOne && draft.thankYouEn.trim() === '' ? empty : undefined;
  const arError = emptyOne && draft.thankYouAr.trim() === '' ? empty : undefined;
  const arHint = t('channels:webForm.thankYou.hint', {
    placeholder: WEB_FORM_REFERENCE_PLACEHOLDER,
    sample,
  });

  return (
    <SectionCard
      id={`${id}-after`}
      heading={t('channels:webForm.after.heading')}
      caption={t('channels:webForm.after.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(afterDraftOf(settings));
              setEmptyOne(false);
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:webForm.save')}
          </Button>
        </>
      }
    >
      <Field
        id={`${id}-dept`}
        label={t('channels:webForm.department.label')}
        hint={t('channels:webForm.department.hint')}
      >
        <Select
          id={`${id}-dept`}
          size="small"
          fullWidth
          displayEmpty
          value={draft.departmentId ?? FIRST_DEPARTMENT}
          onChange={(event) => {
            const value = String(event.target.value);
            setDraft((held) => ({
              ...held,
              departmentId: value === FIRST_DEPARTMENT ? null : value,
            }));
          }}
          inputProps={{ 'aria-label': t('channels:webForm.department.label') }}
        >
          <MenuItem value={FIRST_DEPARTMENT}>
            {t('channels:webForm.department.default', { name: first })}
          </MenuItem>
          {departments.map((department) => (
            <MenuItem key={department.id} value={department.id}>
              {department.name}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <CheckRow
        id={`${id}-captcha`}
        checked={draft.captchaEnabled}
        label={t('channels:webForm.captcha.label')}
        hint={t('channels:webForm.captcha.hint')}
        onChange={(captchaEnabled) => {
          setDraft((held) => ({ ...held, captchaEnabled }));
        }}
      />
      {draft.captchaEnabled && !settings.captcha.ready ? (
        <AlertBanner tone="warning">{t('channels:webForm.captcha.missingKeys')}</AlertBanner>
      ) : null}

      <Field id={`${id}-en`} label={t('channels:webForm.thankYou.en')} error={enError}>
        <TextField
          id={`${id}-en`}
          multiline
          minRows={3}
          size="small"
          value={draft.thankYouEn}
          error={enError !== undefined}
          onChange={(event) => {
            setDraft((held) => ({ ...held, thankYouEn: event.target.value }));
          }}
          slotProps={{
            htmlInput: {
              lang: 'en',
              dir: 'ltr',
              maxLength: 1000,
              'aria-describedby': fieldDescribedBy(`${id}-en`, { error: enError }),
            },
          }}
        />
      </Field>
      <Field
        id={`${id}-ar`}
        label={t('channels:webForm.thankYou.ar')}
        hint={arHint}
        error={arError}
      >
        <TextField
          id={`${id}-ar`}
          multiline
          minRows={3}
          size="small"
          value={draft.thankYouAr}
          error={arError !== undefined}
          onChange={(event) => {
            setDraft((held) => ({ ...held, thankYouAr: event.target.value }));
          }}
          slotProps={{
            htmlInput: {
              lang: 'ar',
              dir: 'rtl',
              maxLength: 1000,
              'aria-describedby': fieldDescribedBy(`${id}-ar`, { hint: arHint, error: arError }),
            },
          }}
        />
      </Field>
    </SectionCard>
  );
}

function PreviewCard({
  thankYou,
  reference,
}: {
  readonly thankYou: WebFormSettings['thankYou'];
  readonly reference: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const id = useId();
  const [before, after] = thankYou[locale].split(WEB_FORM_REFERENCE_PLACEHOLDER, 2);

  return (
    <Box
      component="section"
      aria-labelledby={`${id}-preview`}
      sx={{
        borderRadius: '10px',
        backgroundColor: tokens['bg.surface'],
        border: `1px solid ${tokens['border.default']}`,
        display: 'flex',
        flexDirection: 'column',
        paddingBlock: 4,
        paddingInline: 5,
        gap: 3,
      }}
    >
      <Typography id={`${id}-preview`} variant="bodyStrong" component="h2">
        {t('channels:webForm.preview.heading')}
      </Typography>
      <Box
        sx={{
          padding: 5,
          borderRadius: '10px',
          backgroundColor: tokens['bg.canvas'],
          border: `1px solid ${tokens['border.default']}`,
          display: 'flex',
          gap: 3,
          fontSize: 16,
          lineHeight: '24px',
        }}
      >
        <Box
          aria-hidden="true"
          sx={{
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: '999px',
            backgroundColor: tokens['status.success.tint'],
            color: tokens['status.success'],
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CircleCheck size={16} />
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography component="span" sx={{ fontWeight: 600, fontSize: 16 }}>
            {t('channels:webForm.preview.title')}
          </Typography>
          <Typography component="span" sx={{ fontSize: 16 }}>
            {before}
            {after === undefined ? null : (
              <>
                <Box
                  component="bdi"
                  sx={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 15 }}
                >
                  {reference}
                </Box>
                {after}
              </>
            )}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

/** A labelled checkbox with a hint under the label, as the artboard draws "The form is on". */
function CheckRow({
  id,
  checked,
  label,
  hint,
  onChange,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly label: string;
  readonly hint: string;
  onChange(checked: boolean): void;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
      <Checkbox
        id={id}
        size="small"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        slotProps={{ input: { 'aria-describedby': `${id}-hint` } }}
        sx={{ padding: 0, marginBlockStart: '2px' }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <Typography component="label" htmlFor={id} variant="bodyStrong">
          {label}
        </Typography>
        <Typography
          id={`${id}-hint`}
          variant="body2"
          component="span"
          sx={{ color: 'text.secondary' }}
        >
          {hint}
        </Typography>
      </Box>
    </Box>
  );
}
