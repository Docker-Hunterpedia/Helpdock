import type {
  CaptchaProvider,
  WidgetAccess,
  WidgetAccessUpdate,
  WidgetSettings,
} from '@helpdock/schemas';
import { Box, Button, IconButton, MenuItem, Select, TextField, Typography } from '@mui/material';
import { Globe, Plus, ShieldCheck, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useChannelsApi } from '../../../../auth/session.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { SectionCard, useEmailAction } from '../section-card.tsx';
import { CheckRow } from './conversation-card.tsx';
import { checkOrigin } from './widget-draft.js';

type Access = NonNullable<WidgetSettings['access']>;

interface AccessDraft {
  origins: string[];
  captchaEnabled: boolean;
  captchaProvider: CaptchaProvider;
  captchaSiteKey: string;
  /** Null keeps the saved secret; a string replaces it. */
  captchaSecret: string | null;
}

const draftOf = (access: Access): AccessDraft => ({
  origins: [...access.allowedOrigins],
  captchaEnabled: access.captchaEnabled,
  captchaProvider: access.captchaProvider,
  captchaSiteKey: access.captchaSiteKey,
  captchaSecret: null,
});

/**
 * "Where the widget may run" (M4-03; artboard `AdminWidget`), Admins only:
 * the allowed origins (DESIGN §6.3 OriginList) and the bot check before the
 * first message (ADR 0003). The CAPTCHA keys are the brand's, shared with the
 * web form; the secret is a SecretField — never shown, only replaced.
 */
export function AccessCard({
  brandId,
  access,
  onSaved,
}: {
  readonly brandId: string;
  readonly access: Access;
  readonly onSaved: (settings: WidgetSettings) => void;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const id = useId();
  const [draft, setDraft] = useState<AccessDraft>(() => draftOf(access));
  const [adding, setAdding] = useState('');
  const [originProblem, setOriginProblem] = useState<'invalid' | 'duplicate' | null>(null);
  const [needsKeys, setNeedsKeys] = useState(false);

  useEffect(() => {
    setDraft(draftOf(access));
  }, [access]);

  const save = useEmailAction(
    (request: WidgetAccessUpdate) => api.saveWidgetAccess(brandId, request),
    t('channels:widget.access.saved'),
    onSaved,
  );

  const add = (): void => {
    const outcome = checkOrigin(adding, draft.origins);
    if (!outcome.ok) {
      setOriginProblem(outcome.reason);
      return;
    }
    setDraft((held) => ({ ...held, origins: [...held.origins, outcome.origin] }));
    setAdding('');
    setOriginProblem(null);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const hasSecret =
      draft.captchaSecret !== null
        ? draft.captchaSecret.trim() !== ''
        : access.captchaSecret !== null;
    if (draft.captchaEnabled && (draft.captchaSiteKey.trim() === '' || !hasSecret)) {
      setNeedsKeys(true);
      return;
    }
    setNeedsKeys(false);
    const request: WidgetAccess & { captchaSecret?: string } = {
      allowedOrigins: draft.origins,
      captchaEnabled: draft.captchaEnabled,
      captchaProvider: draft.captchaProvider,
      captchaSiteKey: draft.captchaSiteKey.trim(),
      ...(draft.captchaSecret === null ? {} : { captchaSecret: draft.captchaSecret.trim() }),
    };
    save.mutate(request);
  };

  const originError =
    originProblem === null
      ? undefined
      : originProblem === 'invalid'
        ? t('channels:widget.access.badOrigin')
        : t('channels:widget.access.duplicate');
  const addId = `${id}-origin`;
  const stamp = access.captchaSecret;
  const date = (iso: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  const secretHint =
    stamp === null
      ? t('channels:widget.access.noSecret')
      : stamp.setBy === null
        ? t('channels:widget.access.secretSavedBySystem', { date: date(stamp.setAt) })
        : t('channels:widget.access.secretSaved', { date: date(stamp.setAt), name: stamp.setBy });

  return (
    <SectionCard
      id={`${id}-access`}
      heading={t('channels:widget.access.heading')}
      caption={t('channels:widget.access.caption')}
      aside={<AdminsOnly />}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(draftOf(access));
              setOriginProblem(null);
              setNeedsKeys(false);
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
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography id={`${id}-origins`} sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('channels:widget.access.origins')}
        </Typography>
        <Box
          component="ul"
          aria-labelledby={`${id}-origins`}
          sx={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            border: `1px solid ${tokens['border.default']}`,
            borderRadius: '6px',
          }}
        >
          {draft.origins.map((origin, index) => (
            <Box
              component="li"
              key={origin}
              sx={{
                minHeight: 40,
                paddingInline: 3,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                ...(index === 0 ? {} : { borderBlockStart: `1px solid ${tokens['bg.muted']}` }),
              }}
            >
              <Globe size={14} aria-hidden="true" />
              <Typography variant="mono" sx={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                <bdi>{origin}</bdi>
              </Typography>
              <IconButton
                size="small"
                aria-label={t('channels:widget.access.remove', { origin })}
                onClick={() =>
                  setDraft((held) => ({
                    ...held,
                    origins: held.origins.filter((o) => o !== origin),
                  }))
                }
              >
                <X size={16} aria-hidden="true" />
              </IconButton>
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
          <Box sx={{ flex: '1 1 240px' }}>
            <Field id={addId} label={t('channels:widget.access.addLabel')} error={originError}>
              <TextField
                id={addId}
                size="small"
                fullWidth
                value={adding}
                placeholder="https://shop.example.com"
                error={originError !== undefined}
                onChange={(event) => {
                  setAdding(event.target.value);
                  setOriginProblem(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    add();
                  }
                }}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    spellCheck: false,
                    inputMode: 'url',
                    'aria-invalid': originError !== undefined,
                    'aria-describedby': fieldDescribedBy(addId, { error: originError }),
                  },
                }}
              />
            </Field>
          </Box>
          <Button
            variant="outlined"
            onClick={add}
            startIcon={<Plus size={16} aria-hidden="true" />}
            sx={{ marginBlockStart: '26px' }}
          >
            {t('channels:widget.access.add')}
          </Button>
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:widget.access.originsHint')}
        </Typography>
      </Box>

      <Box
        sx={{
          paddingBlockStart: 4,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <CheckRow
          id={`${id}-captcha`}
          checked={draft.captchaEnabled}
          label={t('channels:widget.access.captcha')}
          hint={t('channels:widget.access.captchaHint')}
          onChange={(checked) => setDraft((held) => ({ ...held, captchaEnabled: checked }))}
        />
        <Box
          sx={{
            paddingInlineStart: 7,
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 4,
          }}
        >
          <Field id={`${id}-provider`} label={t('channels:widget.access.provider')}>
            <Select
              id={`${id}-provider`}
              size="small"
              value={draft.captchaProvider}
              onChange={(event) =>
                setDraft((held) => ({
                  ...held,
                  captchaProvider: event.target.value as CaptchaProvider,
                }))
              }
            >
              <MenuItem value="turnstile">
                {t('channels:widget.access.providers.turnstile')}
              </MenuItem>
              <MenuItem value="hcaptcha">{t('channels:widget.access.providers.hcaptcha')}</MenuItem>
            </Select>
          </Field>
          <Field id={`${id}-site-key`} label={t('channels:widget.access.siteKey')}>
            <TextField
              id={`${id}-site-key`}
              size="small"
              value={draft.captchaSiteKey}
              onChange={(event) =>
                setDraft((held) => ({ ...held, captchaSiteKey: event.target.value }))
              }
              slotProps={{ htmlInput: { dir: 'ltr', spellCheck: false } }}
            />
          </Field>
          <Box sx={{ gridColumn: { md: '1 / -1' } }}>
            <Field
              id={`${id}-secret`}
              label={t('channels:widget.access.secretKey')}
              hint={secretHint}
              {...(needsKeys ? { error: t('channels:widget.access.needsKeys') } : {})}
            >
              <Box sx={{ display: 'flex', gap: 2 }}>
                <TextField
                  id={`${id}-secret`}
                  size="small"
                  type="password"
                  fullWidth
                  value={draft.captchaSecret ?? (stamp === null ? '' : '••••••••••••••••')}
                  error={needsKeys}
                  onChange={(event) =>
                    setDraft((held) => ({ ...held, captchaSecret: event.target.value }))
                  }
                  slotProps={{
                    htmlInput: {
                      dir: 'ltr',
                      autoComplete: 'off',
                      readOnly: draft.captchaSecret === null && stamp !== null,
                      'aria-describedby': fieldDescribedBy(`${id}-secret`, {
                        hint: secretHint,
                        ...(needsKeys ? { error: t('channels:widget.access.needsKeys') } : {}),
                      }),
                    },
                  }}
                />
                {stamp === null ? null : (
                  <Button
                    variant="outlined"
                    onClick={() =>
                      setDraft((held) => ({
                        ...held,
                        captchaSecret: held.captchaSecret === null ? '' : null,
                      }))
                    }
                  >
                    {draft.captchaSecret === null
                      ? t('channels:widget.access.replace')
                      : t('channels:widget.access.keepSecret')}
                  </Button>
                )}
              </Box>
            </Field>
          </Box>
        </Box>
      </Box>
    </SectionCard>
  );
}

/** The "Admins only" label beside an Admin-only card's heading (DESIGN §6.2 Label). */
export function AdminsOnly(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  return (
    <Typography
      variant="caption"
      sx={{
        paddingInline: '6px',
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: 'text.secondary',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <ShieldCheck size={12} aria-hidden="true" />
      {t('channels:widget.access.adminsOnly')}
    </Typography>
  );
}
