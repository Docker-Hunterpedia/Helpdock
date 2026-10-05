import type { HcStructure, HcVisibility, ProposalDetail, ProposalSummary } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Globe, Lock, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { articleRoute, ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { assistKeys, isAssistError } from '../../assist/api.js';
import { useAssistApi } from '../../assist/context.tsx';
import { currentBrand, useSession } from '../../auth/session.tsx';
import { helpCenterKeys } from '../../help-center/api.js';
import { useHelpCenterApi } from '../../help-center/context.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { AIBadge } from '../tickets/ai/ai-badge.tsx';
import { formatCost } from '../tickets/ai/ai-log-disclosure.tsx';

/**
 * Help center › Proposals (M7-05, `Admin/HelpCenter-ArticleApproval`): the
 * articles agents drafted from closed tickets, waiting for a Team Leader. The
 * list on the start, the read-only draft in the middle, and where it would
 * go — section, language, visibility — with the AI draft's figures at the
 * end. "Approve and open in editor" creates a draft article and opens it;
 * nothing is published until a person publishes it.
 */

type Shown = 'waiting' | 'decided';

const timeOf = (iso: string, locale: 'en' | 'ar'): string =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));

export function ProposalsTab(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const api = useAssistApi();
  const [params, setParams] = useSearchParams();
  const [shown, setShown] = useState<Shown>('waiting');
  const listId = useId();

  const list = useQuery({
    queryKey: assistKeys.proposalList(brand.id, shown),
    queryFn: () => api.proposals(brand.id, { status: shown }),
  });
  const selectedId = params.get('proposal') ?? list.data?.items[0]?.id ?? null;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: '300px 1fr' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Box
        component="section"
        aria-labelledby={listId}
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Typography id={listId} component="h2" sx={{ fontSize: 16, fontWeight: 600 }}>
            {t('helpCenter:proposals.heading')}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={shown}
            aria-label={t('helpCenter:proposals.heading')}
            onChange={(_event, next: Shown | null) => {
              if (next !== null) {
                setShown(next);
                setParams({});
              }
            }}
          >
            <ToggleButton value="waiting">
              {t('helpCenter:proposals.waiting')}
              <Typography
                variant="mono"
                component="span"
                sx={{ fontSize: 12, marginInlineStart: 1 }}
              >
                {list.data?.waiting ?? ''}
              </Typography>
            </ToggleButton>
            <ToggleButton value="decided">{t('helpCenter:proposals.decided')}</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        {list.data?.items.length === 0 ? (
          <Typography variant="body2" sx={{ padding: 4, color: 'text.secondary' }}>
            {t(
              shown === 'waiting'
                ? 'helpCenter:proposals.noneWaiting'
                : 'helpCenter:proposals.noneDecided',
            )}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(list.data?.items ?? []).map((item) => (
              <ProposalRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => {
                  setParams({ proposal: item.id });
                }}
              />
            ))}
          </Box>
        )}
        <Typography
          variant="caption"
          component="p"
          sx={{
            padding: 4,
            color: 'text.secondary',
            borderBlockStart: `1px solid ${tokens['border.default']}`,
          }}
        >
          {t('helpCenter:proposals.footnote')}
        </Typography>
      </Box>

      {selectedId === null ? null : <ProposalReview key={selectedId} proposalId={selectedId} />}
    </Box>
  );
}

function ProposalRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: ProposalSummary;
  readonly selected: boolean;
  onSelect(): void;
}): ReactNode {
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();

  return (
    <Box component="li" sx={{ borderBlockStart: `1px solid ${tokens['border.default']}` }}>
      <Box
        component="button"
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        sx={{
          all: 'unset',
          boxSizing: 'border-box',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          width: '100%',
          padding: '12px 16px',
          backgroundColor: selected ? tokens['action.primary.tint'] : undefined,
          borderInlineStart: `3px solid ${selected ? tokens['action.primary'] : 'transparent'}`,
          '&:focus-visible': {
            outline: `2px solid ${tokens['action.primary']}`,
            outlineOffset: -2,
          },
        }}
      >
        <Typography
          component="span"
          lang={item.locale}
          dir={item.locale === 'ar' ? 'rtl' : 'ltr'}
          sx={{ fontWeight: 500, fontSize: 14 }}
        >
          {item.title}
        </Typography>
        <Typography
          component="span"
          variant="caption"
          sx={{ color: 'text.secondary', display: 'flex', gap: 2, flexWrap: 'wrap' }}
        >
          <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
            {item.ticket.reference}
          </Typography>
          {item.proposedBy === null ? null : <bdi>{item.proposedBy}</bdi>}
          <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
            {timeOf(item.proposedAt, locale)}
          </Typography>
          <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
            {item.locale}
          </Typography>
        </Typography>
      </Box>
    </Box>
  );
}

function ProposalReview({ proposalId }: { readonly proposalId: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale: uiLocale } = usePreferences();
  const session = useSession();
  const brand = currentBrand(session);
  const api = useAssistApi();
  const helpCenter = useHelpCenterApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const headingId = useId();
  const [rejecting, setRejecting] = useState(false);

  const proposal = useQuery({
    queryKey: assistKeys.proposal(brand.id, proposalId),
    queryFn: () => api.proposal(brand.id, proposalId),
  });
  const structure = useQuery({
    queryKey: helpCenterKeys.structure(brand.id),
    queryFn: () => helpCenter.structure(brand.id),
  });
  const [sectionId, setSectionId] = useState('');
  const [visibility, setVisibility] = useState<HcVisibility>('public');

  useEffect(() => {
    if (proposal.data !== undefined) {
      setSectionId(proposal.data.sectionId ?? structure.data?.sections[0]?.id ?? '');
    }
  }, [proposal.data, structure.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: assistKeys.proposals(brand.id) });
  const failed = (error: unknown) => {
    toast({
      tone: 'danger',
      message: isAssistError(error)
        ? t(`tickets:assist.failed.${error.reason}`)
        : t('tickets:assist.failed.generic'),
    });
  };
  const approve = useMutation({
    mutationFn: (detail: ProposalDetail) =>
      api.approve(brand.id, proposalId, { sectionId, locale: detail.locale, visibility }),
    onSuccess: async ({ articleId }) => {
      await refresh();
      toast({ tone: 'success', message: t('helpCenter:proposals.approved') });
      void navigate(articleRoute(articleId));
    },
    onError: failed,
  });
  const reject = useMutation({
    mutationFn: (reason: string) => api.reject(brand.id, proposalId, reason),
    onSuccess: async () => {
      setRejecting(false);
      await refresh();
      toast({ tone: 'success', message: t('helpCenter:proposals.rejected') });
    },
    onError: failed,
  });

  const detail = proposal.data;
  if (detail === undefined) {
    return <Box aria-busy="true" sx={{ minHeight: 200 }} />;
  }
  const waiting = detail.status === 'waiting';

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          flexWrap: 'wrap',
          padding: '12px 16px',
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Typography id={headingId} component="h2" sx={{ fontSize: 14, fontWeight: 600 }}>
          {t('helpCenter:proposals.review')}
        </Typography>
        <StatusLabel status={detail.status} />
        {waiting ? (
          <Box sx={{ display: 'flex', gap: 2, marginInlineStart: 'auto' }}>
            <Button
              variant="outlined"
              color="error"
              startIcon={<X size={16} aria-hidden="true" />}
              onClick={() => {
                setRejecting(true);
              }}
            >
              {t('helpCenter:proposals.reject')}
            </Button>
            <Button
              variant="contained"
              disabled={approve.isPending || sectionId === ''}
              startIcon={<Check size={16} aria-hidden="true" />}
              onClick={() => {
                approve.mutate(detail);
              }}
            >
              {t('helpCenter:proposals.approve')}
            </Button>
          </Box>
        ) : null}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 300px' },
        }}
      >
        <Box sx={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <AIBadge />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('helpCenter:proposals.draftedFrom', { count: detail.messageCount })}
            </Typography>
          </Box>
          <Box lang={detail.locale} dir={detail.locale === 'ar' ? 'rtl' : 'ltr'}>
            <Typography component="h3" variant="h1" sx={{ marginBlockEnd: 4 }}>
              {detail.title}
            </Typography>
            <Box
              sx={{
                fontSize: 16,
                lineHeight: '24px',
                '& h2': { fontSize: 20, lineHeight: '28px', fontWeight: 600, marginBlock: 4 },
                '& h3': { fontSize: 16, fontWeight: 600, marginBlock: 3 },
                '& p': { marginBlock: 2 },
              }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered from the draft's Markdown and sanitised with the article allowlist by the api (`proposals.service.ts`).
              dangerouslySetInnerHTML={{ __html: detail.bodyHtml }}
            />
          </Box>
          {detail.status === 'rejected' && detail.rejectReason !== null ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('helpCenter:proposals.rejectedBecause', { reason: detail.rejectReason })}
            </Typography>
          ) : null}
          {detail.articleId === null ? null : (
            <Link component={RouterLink} to={articleRoute(detail.articleId)}>
              {t('helpCenter:proposals.openArticle')}
            </Link>
          )}
        </Box>

        <Box
          component="aside"
          sx={{
            borderInlineStart: { md: `1px solid ${tokens['border.default']}` },
            borderBlockStart: { xs: `1px solid ${tokens['border.default']}`, md: 'none' },
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <SideSection title={t('helpCenter:proposals.source')}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Link component={RouterLink} to={ticketRoute(detail.ticket.id)}>
                <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
                  {detail.ticket.reference}
                </Typography>{' '}
                <bdi>{detail.ticketSubject}</bdi>
              </Link>
              <ExternalLink size={14} aria-hidden="true" />
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('helpCenter:proposals.proposedBy', {
                name: detail.proposedBy ?? t('helpCenter:proposals.someone'),
                time: timeOf(detail.proposedAt, uiLocale),
              })}
            </Typography>
            {detail.note === null ? null : (
              <Typography
                component="blockquote"
                dir="auto"
                sx={{
                  margin: 0,
                  paddingInlineStart: 3,
                  borderInlineStart: `2px solid ${tokens['border.strong']}`,
                  fontSize: 13,
                  color: 'text.secondary',
                }}
              >
                {detail.note}
              </Typography>
            )}
          </SideSection>

          <SideSection title={t('helpCenter:proposals.whereItGoes')}>
            <TextField
              select
              size="small"
              label={t('helpCenter:proposals.section')}
              value={sectionId}
              disabled={!waiting}
              onChange={(event) => {
                setSectionId(event.target.value);
              }}
            >
              {sectionOptions(structure.data, uiLocale).map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2">
              {t('helpCenter:proposals.language')}: {t(`tickets:assist.languages.${detail.locale}`)}
            </Typography>
            <RadioGroup
              aria-label={t('helpCenter:proposals.visibility')}
              value={visibility}
              onChange={(event) => {
                setVisibility(event.target.value === 'internal' ? 'internal' : 'public');
              }}
            >
              <FormControlLabel
                value="public"
                disabled={!waiting}
                control={<Radio size="small" />}
                label={
                  <Box
                    component="span"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
                  >
                    <Globe size={14} aria-hidden="true" />
                    {t('helpCenter:visibility.public')}
                  </Box>
                }
              />
              <FormControlLabel
                value="internal"
                disabled={!waiting}
                control={<Radio size="small" />}
                label={
                  <Box
                    component="span"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
                  >
                    <Lock size={14} aria-hidden="true" />
                    {t('helpCenter:visibility.internal')}
                  </Box>
                }
              />
            </RadioGroup>
          </SideSection>

          <SideSection title={t('helpCenter:proposals.aiDraft')}>
            <Box
              component="dl"
              sx={(theme) => ({
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                columnGap: 4,
                rowGap: 1,
                margin: 0,
                fontSize: 12,
                '& dt': { color: 'text.secondary' },
                '& dd': { margin: 0 },
                '& dd.mono': { fontFamily: theme.typography.mono.fontFamily },
              })}
            >
              {detail.call === null ? null : (
                <>
                  <dt>{t('tickets:autoReply.logModel')}</dt>
                  <dd className="mono">{detail.call.model}</dd>
                  <dt>{t('tickets:autoReply.logCost')}</dt>
                  <dd className="mono">{formatCost(detail.call.costUsd)}</dd>
                  <dt>{t('tickets:autoReply.logRedactions')}</dt>
                  <dd>
                    {detail.call.redactionCount === 0
                      ? '0'
                      : `${String(detail.call.redactionCount)} · ${detail.call.redactionKinds
                          .map((kind) => t(`tickets:assist.piiKinds.${kind}`))
                          .join(', ')}`}
                  </dd>
                </>
              )}
              <dt>{t('helpCenter:proposals.cites')}</dt>
              <dd>
                {detail.citations.length === 0
                  ? t('helpCenter:proposals.citesNothing')
                  : detail.citations.map((citation) => citation.title).join(', ')}
              </dd>
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('helpCenter:proposals.approveHint')}
            </Typography>
          </SideSection>
        </Box>
      </Box>

      <RejectDialog
        open={rejecting}
        busy={reject.isPending}
        onClose={() => {
          setRejecting(false);
        }}
        onReject={(reason) => {
          reject.mutate(reason);
        }}
      />
    </Box>
  );
}

const sectionOptions = (structure: HcStructure | undefined, locale: 'en' | 'ar') =>
  (structure?.sections ?? []).map((section) => {
    const category = structure?.categories.find((entry) => entry.id === section.categoryId);
    const name = (names: { en: string; ar: string } | undefined) =>
      names === undefined ? '' : locale === 'ar' && names.ar !== '' ? names.ar : names.en;
    return { id: section.id, label: `${name(category?.names)} › ${name(section.names)}` };
  });

function SideSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const id = useId();
  return (
    <Box
      component="section"
      aria-labelledby={id}
      sx={{
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        '& + &': { borderBlockStart: `1px solid ${tokens['border.default']}` },
      }}
    >
      <Typography id={id} component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function StatusLabel({ status }: { readonly status: ProposalDetail['status'] }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone = status === 'waiting' ? 'warning' : status === 'approved' ? 'success' : 'danger';
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        fontSize: 12,
        fontWeight: 500,
        color: tokens[`status.${tone}.text`],
        '&::before': {
          content: '""',
          width: 6,
          height: 6,
          borderRadius: '999px',
          backgroundColor: tokens[`status.${tone}`],
        },
      }}
    >
      {t(`helpCenter:proposals.status.${status}`)}
    </Box>
  );
}

function RejectDialog({
  open,
  busy,
  onClose,
  onReject,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  onClose(): void;
  onReject(reason: string): void;
}): ReactNode {
  const t = useT();
  const titleId = useId();
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 480 } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600 }}>
        {t('helpCenter:proposals.rejectTitle')}
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          label={t('helpCenter:proposals.rejectReason')}
          helperText={t('helpCenter:proposals.rejectHint')}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          slotProps={{ htmlInput: { maxLength: 1_000, dir: 'auto' } }}
          sx={{ marginBlockStart: 2 }}
        />
      </DialogContent>
      <DialogActions sx={{ padding: 4, gap: 2 }}>
        <Button variant="text" onClick={onClose} disabled={busy}>
          {t('tickets:assist.draft.cancel')}
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={busy || reason.trim() === ''}
          onClick={() => {
            onReject(reason.trim());
          }}
        >
          {t('helpCenter:proposals.rejectSubmit')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
