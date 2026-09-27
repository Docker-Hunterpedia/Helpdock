import type { Locale } from '@helpdock/i18n';
import {
  AUTO_REPLY_CAP_MAX,
  AUTO_REPLY_CAP_MIN,
  type AutoReplies,
  type AutoReplyKind,
  type AutoReplyTemplate,
  type EmailOutgoingSettings,
} from '@helpdock/schemas';
import { Box, Button, Link, Switch, TextField, Typography } from '@mui/material';
import { Clock, FileText, ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useEmailApi } from '../../../auth/session.tsx';
import { SectionCard, useEmailAction } from './section-card.tsx';
import { TemplateDialog } from './template-dialog.tsx';

/**
 * "Auto-replies" of `Admin/Channels · Outgoing email` (M2-06): the two toggles,
 * a link per language to each template, and the loop-protection cap.
 *
 * The toggles and the cap are one form with one Save. A template is edited in
 * its own dialog and saved from there, as the artboard draws it, on top of the
 * stored settings — so saving a template never saves a toggle somebody has not
 * finished deciding about.
 */

interface AutoDraft {
  acknowledgment: boolean;
  outOfHours: boolean;
  cap: string;
}

const draftOf = (replies: AutoReplies): AutoDraft => ({
  acknowledgment: replies.acknowledgment.enabled,
  outOfHours: replies.outOfHours.enabled,
  cap: String(replies.perSenderHourlyCap),
});

export const capOf = (value: string): number | null => {
  const cap = Number(value);
  return Number.isInteger(cap) && cap >= AUTO_REPLY_CAP_MIN && cap <= AUTO_REPLY_CAP_MAX
    ? cap
    : null;
};

export function AutoRepliesCard({
  brandId,
  settings,
  onSaved,
}: {
  readonly brandId: string;
  readonly settings: EmailOutgoingSettings;
  onSaved(settings: EmailOutgoingSettings): void;
}): ReactNode {
  const t = useT();
  const api = useEmailApi();
  const tokens = useSemanticTokens();
  const id = useId();
  const stored = settings.autoReplies;
  const [draft, setDraft] = useState<AutoDraft>(() => draftOf(stored));
  const [capWrong, setCapWrong] = useState(false);
  const [editing, setEditing] = useState<{ kind: AutoReplyKind; locale: Locale } | null>(null);

  useEffect(() => {
    setDraft(draftOf(stored));
  }, [stored]);

  const save = useEmailAction(
    (request: AutoReplies) => api.saveAutoReplies(brandId, request),
    t('channels:autoReplies.saved'),
    onSaved,
  );
  const saveTemplate = useEmailAction(
    (request: AutoReplies) => api.saveAutoReplies(brandId, request),
    t('channels:template.saved'),
    (saved: EmailOutgoingSettings) => {
      setEditing(null);
      onSaved(saved);
    },
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const cap = capOf(draft.cap);
    setCapWrong(cap === null);
    if (cap !== null) {
      save.mutate({
        acknowledgment: { ...stored.acknowledgment, enabled: draft.acknowledgment },
        outOfHours: { ...stored.outOfHours, enabled: draft.outOfHours },
        perSenderHourlyCap: cap,
      });
    }
  };

  const templateLinks = (kind: AutoReplyKind): ReactNode => (
    <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBlockStart: 1 }}>
      {(['en', 'ar'] as const).map((locale) => (
        <Link
          key={locale}
          component="button"
          type="button"
          variant="body2"
          aria-label={t('channels:autoReplies.editTemplate', {
            kind: t(`channels:template.kinds.${kind}`),
            language: t(`channels:template.languages.${locale}`),
          })}
          onClick={() => {
            setEditing({ kind, locale });
          }}
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
        >
          <FileText size={14} aria-hidden="true" />
          {locale === 'en' ? (
            t('channels:autoReplies.templateEn')
          ) : (
            <span lang="ar">{t('channels:autoReplies.templateAr')}</span>
          )}
        </Link>
      ))}
    </Box>
  );

  return (
    <SectionCard
      id={`${id}-auto`}
      heading={t('channels:autoReplies.heading')}
      caption={t('channels:autoReplies.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(draftOf(stored));
              setCapWrong(false);
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:autoReplies.save')}
          </Button>
        </>
      }
    >
      <Toggle
        id={`${id}-ack`}
        checked={draft.acknowledgment}
        label={t('channels:autoReplies.acknowledgment')}
        hint={t('channels:autoReplies.acknowledgmentHint')}
        onChange={(acknowledgment) => {
          setDraft((held) => ({ ...held, acknowledgment }));
        }}
      >
        {templateLinks('acknowledgment')}
      </Toggle>

      <Box sx={{ borderBlockStart: `1px solid ${tokens['border.default']}` }} />

      <Toggle
        id={`${id}-ooh`}
        checked={draft.outOfHours}
        label={t('channels:autoReplies.outOfHours')}
        hint={t('channels:autoReplies.outOfHoursHint')}
        onChange={(outOfHours) => {
          setDraft((held) => ({ ...held, outOfHours }));
        }}
      >
        {templateLinks('outOfHours')}
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            marginBlockStart: 1,
          }}
        >
          <Clock size={12} aria-hidden="true" />
          {t('channels:autoReplies.hoursNote')}
        </Typography>
      </Toggle>

      <Box
        sx={{
          padding: 4,
          borderRadius: '6px',
          backgroundColor: tokens['bg.canvas'],
          border: `1px solid ${tokens['border.default']}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography
          variant="body2"
          component="h3"
          sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}
        >
          <ShieldCheck size={14} aria-hidden="true" />
          {t('channels:autoReplies.loopHeading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:autoReplies.loopBody')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography component="label" htmlFor={`${id}-cap`} variant="body2">
            {t('channels:autoReplies.capBefore')}
          </Typography>
          <TextField
            id={`${id}-cap`}
            size="small"
            type="number"
            value={draft.cap}
            error={capWrong}
            onChange={(event) => {
              setDraft((held) => ({ ...held, cap: event.target.value }));
            }}
            sx={{ width: 80 }}
            slotProps={{
              htmlInput: {
                min: AUTO_REPLY_CAP_MIN,
                max: AUTO_REPLY_CAP_MAX,
                'aria-label': t('channels:autoReplies.capLabel'),
                'aria-describedby': `${id}-cap-after`,
              },
            }}
          />
          <Typography id={`${id}-cap-after`} variant="body2" sx={{ color: 'text.secondary' }}>
            {t('channels:autoReplies.capAfter')}
          </Typography>
        </Box>
        {capWrong ? (
          <Typography variant="caption" role="alert" sx={{ color: tokens['status.danger.text'] }}>
            {t('channels:autoReplies.capInvalid')}
          </Typography>
        ) : null}
      </Box>

      {editing === null ? null : (
        <TemplateDialog
          kind={editing.kind}
          locale={editing.locale}
          template={stored[editing.kind].templates[editing.locale]}
          busy={saveTemplate.isPending}
          onCancel={() => {
            setEditing(null);
          }}
          onSave={(template: AutoReplyTemplate) => {
            saveTemplate.mutate({
              ...stored,
              [editing.kind]: {
                ...stored[editing.kind],
                templates: { ...stored[editing.kind].templates, [editing.locale]: template },
              },
            });
          }}
        />
      )}
    </SectionCard>
  );
}

function Toggle({
  id,
  checked,
  label,
  hint,
  onChange,
  children,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly label: string;
  readonly hint: string;
  onChange(checked: boolean): void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
      <Switch
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        slotProps={{
          input: {
            role: 'switch',
            'aria-labelledby': `${id}-label`,
            'aria-describedby': `${id}-hint`,
          },
        }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <Typography id={`${id}-label`} variant="bodyStrong" component="span">
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
        {children}
      </Box>
    </Box>
  );
}
