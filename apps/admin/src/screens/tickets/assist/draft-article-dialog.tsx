import type { DraftArticleResult, HcStructure, ProposalCreateRequest } from '@helpdock/schemas';
import { ARTICLE_DRAFT_BODY_MAX, ARTICLE_DRAFT_TITLE_MAX } from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { RefreshCw, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { AIBadge } from '../ai/ai-badge.tsx';
import { formatCost } from '../ai/ai-log-disclosure.tsx';

/**
 * "Draft an article from HD-1029" (`Admin/Ticket-AI` panel 5, dialog 720):
 * the assistant's draft from a closed ticket's public messages, which the
 * agent edits and sends for a Team Leader's approval with an optional note.
 * Nothing reaches the help center from here.
 */
export function DraftArticleDialog({
  open,
  reference,
  structure,
  draft,
  drafting,
  sending,
  onDraft,
  onSend,
  onClose,
}: {
  readonly open: boolean;
  readonly reference: string;
  readonly structure: HcStructure | undefined;
  /** Null until the first draft arrives. */
  readonly draft: DraftArticleResult | null;
  readonly drafting: boolean;
  readonly sending: boolean;
  onDraft(locale: 'en' | 'ar'): void;
  onSend(request: ProposalCreateRequest): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const { locale: uiLocale } = usePreferences();
  const titleId = useId();
  const [sectionId, setSectionId] = useState('');
  const [locale, setLocale] = useState<'en' | 'ar'>('en');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (draft !== null) {
      setTitle(draft.title);
      setBody(draft.bodyMarkdown);
      setLocale(draft.locale);
    }
  }, [draft]);

  useEffect(() => {
    if (open) {
      setNote('');
    }
  }, [open]);

  const sections = (structure?.sections ?? []).map((section) => {
    const category = structure?.categories.find((entry) => entry.id === section.categoryId);
    const name = (names: { en: string; ar: string } | undefined) =>
      names === undefined ? '' : uiLocale === 'ar' && names.ar !== '' ? names.ar : names.en;
    return { id: section.id, label: `${name(category?.names)} › ${name(section.names)}` };
  });

  const ready = draft !== null && title.trim() !== '' && body.trim() !== '';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) {
      return;
    }
    onSend({
      sectionId: sectionId === '' ? null : sectionId,
      locale,
      title: title.trim(),
      bodyMarkdown: body.trim(),
      note: note.trim() === '' ? null : note.trim(),
      callId: draft.meta.callId,
      messageCount: draft.messageCount,
      citations: draft.citations.map((citation) => ({
        title: citation.title,
        articleId: citation.articleId,
      })),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 720 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, paddingInlineEnd: 3 }}>
          <Box sx={{ flex: 1 }}>
            <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600, paddingBlockEnd: 1 }}>
              {t('tickets:assist.draft.title')}{' '}
              <Typography variant="mono" component="span" sx={{ fontSize: 16 }}>
                {reference}
              </Typography>
            </DialogTitle>
            <Typography variant="body2" sx={{ color: 'text.secondary', paddingInline: 6 }}>
              {t('tickets:assist.draft.caption')}
            </Typography>
          </Box>
          <IconButton
            aria-label={t('tickets:assist.draft.close')}
            onClick={onClose}
            sx={{ marginBlockStart: 4 }}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 3 }}>
            <TextField
              select
              size="small"
              label={t('tickets:assist.draft.section')}
              value={sectionId}
              onChange={(event) => {
                setSectionId(event.target.value);
              }}
            >
              <MenuItem value="">{t('tickets:assist.draft.reviewerChooses')}</MenuItem>
              {sections.map((section) => (
                <MenuItem key={section.id} value={section.id}>
                  {section.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label={t('tickets:assist.draft.language')}
              value={locale}
              onChange={(event) => {
                const next = event.target.value === 'ar' ? 'ar' : 'en';
                setLocale(next);
                onDraft(next);
              }}
            >
              <MenuItem value="en">English</MenuItem>
              <MenuItem value="ar" lang="ar">
                العربية
              </MenuItem>
            </TextField>
          </Box>

          {draft === null ? (
            <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 2, padding: 4 }}>
              <CircularProgress size={16} aria-hidden="true" />
              <Typography variant="body2">{t('tickets:assist.draft.drafting')}</Typography>
            </Box>
          ) : (
            <>
              <TextField
                size="small"
                label={t('tickets:assist.draft.articleTitle')}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
                slotProps={{
                  htmlInput: { maxLength: ARTICLE_DRAFT_TITLE_MAX, lang: locale, dir: 'auto' },
                }}
              />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography
                    component="label"
                    htmlFor={`${titleId}-body`}
                    variant="body2"
                    sx={{ fontWeight: 500 }}
                  >
                    {t('tickets:assist.draft.body')}
                  </Typography>
                  <AIBadge />
                </Box>
                <TextField
                  id={`${titleId}-body`}
                  multiline
                  minRows={8}
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                  }}
                  slotProps={{
                    htmlInput: { maxLength: ARTICLE_DRAFT_BODY_MAX, lang: locale, dir: 'auto' },
                  }}
                />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {draft.citations.length === 0
                    ? t('tickets:assist.draft.from', { count: draft.messageCount })
                    : t('tickets:assist.draft.fromCiting', {
                        count: draft.messageCount,
                        titles: draft.citations.map((citation) => `“${citation.title}”`).join(', '),
                      })}{' '}
                  {t('tickets:assist.draft.check')}
                </Typography>
              </Box>
              <TextField
                size="small"
                multiline
                minRows={2}
                label={t('tickets:assist.draft.note')}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
                slotProps={{ htmlInput: { maxLength: 1_000, dir: 'auto' } }}
              />
            </>
          )}
        </DialogContent>

        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button
            variant="outlined"
            disabled={drafting}
            startIcon={<RefreshCw size={14} aria-hidden="true" />}
            onClick={() => {
              onDraft(locale);
            }}
          >
            {t('tickets:assist.draft.again')}
          </Button>
          {draft === null ? null : (
            <Typography variant="mono" sx={{ fontSize: 12, color: 'text.secondary' }}>
              {`${draft.meta.model} · ${formatCost(draft.meta.costUsd)}`}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <Button variant="text" onClick={onClose} disabled={sending}>
            {t('tickets:assist.draft.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={!ready || sending || drafting}>
            {t('tickets:assist.draft.send')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
