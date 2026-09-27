import type { Locale } from '@helpdock/i18n';
import type { Brand, BrandUpdateRequest } from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { TimeZoneSelect } from '../ticketing/time-zone-select.tsx';

/**
 * Brand › General, the Identity card of the `AdminBrand` artboard: the name,
 * the ticket prefix (shown, never editable — it is printed in every ticket
 * number), the default language and the time zone, saved through
 * `PATCH /api/brands/:brandId`, which M1-01 ships. The artboard's Domains card
 * is the Domains tab now (M5-07).
 */

interface Draft {
  readonly name: string;
  readonly defaultLocale: Locale;
  readonly timezone: string;
}

const draftOf = (brand: Brand): Draft => ({
  name: brand.name,
  defaultLocale: brand.defaultLocale,
  timezone: brand.timezone,
});

const LOCALES: readonly Locale[] = ['en', 'ar'];

export function GeneralTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const brand = currentBrand(session);
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const headingId = `${id}-heading`;

  const row = useQuery({ queryKey: ['brand', brand.id], queryFn: () => api.brand(brand.id) });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (row.data !== undefined) {
      setDraft(draftOf(row.data));
    }
  }, [row.data]);

  const save = useMutation({
    mutationFn: (request: BrandUpdateRequest) => api.updateBrand(brand.id, request),
    onSuccess: (saved) => {
      queryClient.setQueryData(['brand', brand.id], saved);
      toast({ tone: 'success', message: t('brand:general.saved') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('brand:general.failed') });
    },
  });

  if (row.isError) {
    return <AlertBanner tone="danger">{t('brand:general.loadFailed')}</AlertBanner>;
  }
  if (row.data === undefined || draft === null) {
    return null;
  }

  const saved = draftOf(row.data);
  const dirty =
    draft.name !== saved.name ||
    draft.defaultLocale !== saved.defaultLocale ||
    draft.timezone !== saved.timezone;
  const nameError = draft.name.trim() === '' ? t('brand:general.nameRequired') : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (nameError !== undefined || !dirty) {
      return;
    }
    save.mutate({
      name: draft.name.trim(),
      defaultLocale: draft.defaultLocale,
      timezone: draft.timezone,
    });
  };

  const set = (change: Partial<Draft>): void => {
    setDraft({ ...draft, ...change });
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 720px) 300px' },
        gap: 8,
        alignContent: 'start',
      }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        aria-labelledby={headingId}
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          sx={{
            paddingBlock: 4,
            paddingInline: 5,
            borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
          }}
        >
          <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('brand:general.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
            {t('brand:general.lead')}
          </Typography>
        </Box>

        <Box
          sx={{
            padding: 5,
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 5,
          }}
        >
          <Field id={`${id}-name`} label={t('brand:general.name')} error={nameError}>
            <TextField
              id={`${id}-name`}
              size="small"
              value={draft.name}
              error={nameError !== undefined}
              onChange={(event) => {
                set({ name: event.target.value });
              }}
              slotProps={{
                htmlInput: {
                  maxLength: 120,
                  dir: 'auto',
                  'aria-invalid': nameError !== undefined,
                  'aria-describedby': fieldDescribedBy(`${id}-name`, { error: nameError }),
                },
              }}
            />
          </Field>
          <Field
            id={`${id}-prefix`}
            label={t('brand:general.prefix')}
            hint={t('brand:general.prefixHint')}
          >
            <TextField
              id={`${id}-prefix`}
              size="small"
              value={row.data.prefix}
              slotProps={{
                htmlInput: {
                  readOnly: true,
                  dir: 'ltr',
                  'aria-describedby': fieldDescribedBy(`${id}-prefix`, {
                    hint: t('brand:general.prefixHint'),
                  }),
                  style: { fontFamily: 'var(--hd-font-mono, monospace)' },
                },
              }}
            />
          </Field>
          <Field
            id={`${id}-locale`}
            label={t('brand:general.locale')}
            hint={t('brand:general.localeHint')}
          >
            <TextField
              id={`${id}-locale`}
              select
              size="small"
              value={draft.defaultLocale}
              onChange={(event) => {
                set({ defaultLocale: event.target.value as Locale });
              }}
              slotProps={{
                select: { native: true },
                htmlInput: {
                  'aria-describedby': fieldDescribedBy(`${id}-locale`, {
                    hint: t('brand:general.localeHint'),
                  }),
                },
              }}
            >
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`common:language.${locale}`)}
                </option>
              ))}
            </TextField>
          </Field>
          <TimeZoneSelect
            label={t('brand:general.timezone')}
            helperText={t('brand:general.timezoneHint')}
            value={draft.timezone}
            onChange={(timezone) => {
              set({ timezone });
            }}
          />
        </Box>

        <Box
          sx={{
            paddingBlock: 3,
            paddingInline: 5,
            borderBlockStart: `1px solid ${tokens['bg.muted']}`,
            backgroundColor: tokens['bg.canvas'],
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 2,
            borderEndStartRadius: '10px',
            borderEndEndRadius: '10px',
          }}
        >
          <Button
            type="button"
            variant="text"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(saved);
            }}
          >
            {t('brand:general.discard')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!dirty || nameError !== undefined || save.isPending}
          >
            {t('brand:general.save')}
          </Button>
        </Box>
      </Box>

      <Box
        component="aside"
        aria-labelledby={`${id}-who`}
        sx={{
          alignSelf: 'start',
          paddingBlock: '14px',
          paddingInline: 4,
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography id={`${id}-who`} component="h2" sx={{ fontSize: 13, fontWeight: 600 }}>
          {t('brand:general.whoHeading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
          {t('brand:general.whoBody')}
        </Typography>
      </Box>
    </Box>
  );
}
