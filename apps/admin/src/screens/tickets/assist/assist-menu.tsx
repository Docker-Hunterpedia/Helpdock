import type { AssistState, AssistTone } from '@helpdock/schemas';
import { tokens as designTokens } from '@helpdock/ui';
import {
  Box,
  Button,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Languages,
  ListChecks,
  MessageSquareText,
  PenLine,
  Sparkles,
  Tags,
} from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';

/**
 * DESIGN §6.4 AssistMenu (M7-05, M7-08; `Admin/Ticket-AI` panels 1, 3, 6):
 * the composer's Assist button and the menu it opens upward. Every item runs
 * one model call; an item that cannot run yet stays, disabled, with its
 * reason under it. At the hard stop the menu opens on a danger banner and
 * every item is disabled, unless the brand keeps assist on past its budget.
 * Esc closes and returns focus to Assist (MUI's Menu does both).
 */

export type AssistAction =
  | { readonly kind: 'suggest-reply' }
  | { readonly kind: 'summarize' }
  | { readonly kind: 'suggest-fields' }
  | { readonly kind: 'translate-reply'; readonly target: 'en' | 'ar' }
  | { readonly kind: 'rewrite'; readonly tone: AssistTone }
  | { readonly kind: 'draft-article' };

const TONES: readonly AssistTone[] = ['friendlier', 'formal', 'shorter'];

const dateOf = (iso: string, locale: 'en' | 'ar'): string =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));

export function AssistMenu({
  state,
  draft,
  translateTarget,
  busy,
  onSelect,
  onViewProposal,
}: {
  readonly state: AssistState;
  /** The composer's text: rewriting and translating work on it. */
  readonly draft: string;
  /** The customer's language, which "Translate reply" translates into. */
  readonly translateTarget: 'en' | 'ar';
  readonly busy: boolean;
  onSelect(action: AssistAction): void;
  onViewProposal(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const teal = designTokens.palette.teal;
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const toneRef = useRef<HTMLLIElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tonesOpen, setTonesOpen] = useState(false);
  const draftReasonId = useId();
  const emptyDraftId = useId();

  const exceeded = state.budget.find((window) => window.level === 'exceeded');
  const warning = state.budget.find((window) => window.level === 'warning');
  const stopped = state.blocked !== null;
  const noDraft = draft.trim() === '';
  const proposalWaiting = state.proposal?.status === 'waiting';

  const close = (): void => {
    setTonesOpen(false);
    setOpen(false);
  };
  const choose = (action: AssistAction): void => {
    close();
    onSelect(action);
  };
  const openTones = (): void => {
    if (!stopped && !noDraft) {
      setTonesOpen(true);
    }
  };

  return (
    <>
      <Button
        ref={buttonRef}
        size="small"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        startIcon={<Sparkles size={14} aria-hidden="true" />}
        endIcon={<ChevronDown size={14} aria-hidden="true" />}
        onClick={() => {
          setOpen(true);
        }}
        sx={{
          height: 32,
          paddingInline: 3,
          borderRadius: '6px',
          backgroundColor: tokens['action.primary.tint'],
          border: `1px solid ${teal.teal200}`,
          color: teal.teal700,
          '&:hover': { backgroundColor: tokens['action.primary.tint'] },
        }}
      >
        {t('tickets:assist.button')}
      </Button>
      <Menu
        id={menuId}
        anchorEl={buttonRef.current}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 280 } } }}
      >
        {exceeded === undefined ? null : (
          <Box sx={{ paddingInline: 2, paddingBlockEnd: 2 }}>
            <AlertBanner tone="danger">
              {stopped
                ? t('tickets:assist.budget.stopped', { date: dateOf(exceeded.resetsAt, locale) })
                : t('tickets:assist.budget.keepsAssist', { date: dateOf(exceeded.resetsAt, locale) })}
            </AlertBanner>
          </Box>
        )}
        {exceeded === undefined && warning !== undefined ? (
          <Box sx={{ paddingInline: 2, paddingBlockEnd: 2 }}>
            <AlertBanner tone="warning">
              {t('tickets:assist.budget.warning', {
                percent: Math.round((warning.spentUsd / warning.limitUsd) * 100),
              })}
            </AlertBanner>
          </Box>
        ) : null}
        <MenuItem
          disabled={stopped}
          onClick={() => {
            choose({ kind: 'suggest-reply' });
          }}
        >
          <ListItemIcon>
            <MessageSquareText size={16} aria-hidden="true" />
          </ListItemIcon>
          <ListItemText>{t('tickets:assist.menu.suggestReply')}</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={stopped}
          onClick={() => {
            choose({ kind: 'summarize' });
          }}
        >
          <ListItemIcon>
            <ListChecks size={16} aria-hidden="true" />
          </ListItemIcon>
          <ListItemText>{t('tickets:assist.menu.summarize')}</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={stopped}
          onClick={() => {
            choose({ kind: 'suggest-fields' });
          }}
        >
          <ListItemIcon>
            <Tags size={16} aria-hidden="true" />
          </ListItemIcon>
          <ListItemText>{t('tickets:assist.menu.suggestFields')}</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={stopped || noDraft}
          aria-describedby={noDraft ? emptyDraftId : undefined}
          onClick={() => {
            choose({ kind: 'translate-reply', target: translateTarget });
          }}
        >
          <ListItemIcon>
            <Languages size={16} aria-hidden="true" />
          </ListItemIcon>
          <ListItemText
            secondary={noDraft ? t('tickets:assist.menu.writeFirst') : undefined}
            slotProps={{ secondary: { id: emptyDraftId } }}
          >
            {t('tickets:assist.menu.translate', {
              language: t(`tickets:assist.languages.${translateTarget}`),
            })}
          </ListItemText>
        </MenuItem>
        <MenuItem
          ref={toneRef}
          disabled={stopped || noDraft}
          aria-haspopup="menu"
          aria-expanded={tonesOpen}
          onClick={openTones}
          onKeyDown={(event) => {
            const inward = locale === 'ar' ? 'ArrowLeft' : 'ArrowRight';
            if (event.key === inward) {
              event.preventDefault();
              openTones();
            }
          }}
        >
          <ListItemIcon>
            <PenLine size={16} aria-hidden="true" />
          </ListItemIcon>
          <ListItemText>{t('tickets:assist.menu.rewrite')}</ListItemText>
          <Box
            component="span"
            sx={{ display: 'inline-flex', transform: locale === 'ar' ? 'scaleX(-1)' : undefined }}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </Box>
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={stopped || !state.ticketClosed || proposalWaiting}
          aria-describedby={draftReasonId}
          onClick={() => {
            choose({ kind: 'draft-article' });
          }}
        >
          <ListItemIcon>
            <FileText size={16} aria-hidden="true" />
          </ListItemIcon>
          <ListItemText
            secondary={
              proposalWaiting
                ? t('tickets:assist.menu.sentForApproval')
                : state.ticketClosed
                  ? undefined
                  : t('tickets:assist.menu.onceClosed')
            }
            slotProps={{ secondary: { id: draftReasonId } }}
          >
            {t('tickets:assist.menu.draftArticle')}
          </ListItemText>
        </MenuItem>
        {proposalWaiting ? (
          <MenuItem
            onClick={() => {
              close();
              onViewProposal();
            }}
            sx={{ paddingInlineStart: 7 }}
          >
            <Typography variant="caption" sx={{ color: tokens['text.link'] }}>
              {t('tickets:assist.menu.viewProposal')}
            </Typography>
          </MenuItem>
        ) : null}
        <Typography
          variant="caption"
          component="p"
          sx={{ paddingInline: 4, paddingBlock: 2, color: 'text.secondary', lineHeight: '16px' }}
        >
          {t('tickets:assist.menu.footnote')}
        </Typography>
      </Menu>
      <Menu
        anchorEl={toneRef.current}
        open={open && tonesOpen}
        onClose={() => {
          setTonesOpen(false);
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 160 } } }}
      >
        {TONES.map((tone) => (
          <MenuItem
            key={tone}
            onClick={() => {
              choose({ kind: 'rewrite', tone });
            }}
          >
            {t(`tickets:assist.tones.${tone}`)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
