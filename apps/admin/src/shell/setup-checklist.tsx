import type { SetupChecklist, SetupChecklistStep } from '@helpdock/schemas';
import { Box, Link, Popover, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, CircleCheck, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { currentBrand, useSession, useStaffApi } from '../auth/session.tsx';
import { useToast } from '../ui/toasts.tsx';
import { visuallyHidden } from '../ui/visually-hidden.js';
import { setupStepRoute } from './setup-checklist-steps.js';

const CHECKLIST_STALE_MS = 60_000;
const PANEL_WIDTH = 380;

export const setupChecklistKey = (brandId: string) => ['setup-checklist', brandId] as const;

/** A 4 px track on `border.default`, filled in `action.primary`; the caption beside it says the figure. */
function ProgressBar({ share }: { readonly share: number }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      aria-hidden="true"
      sx={{
        height: 4,
        borderRadius: '999px',
        backgroundColor: tokens['border.default'],
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          width: `${Math.round(share * 100)}%`,
          height: '100%',
          backgroundColor: tokens['action.primary'],
        }}
      />
    </Box>
  );
}

function StepRow({
  step,
  onNavigate,
}: {
  readonly step: SetupChecklistStep;
  readonly onNavigate: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const title = t(`admin:setupChecklist.steps.${step.id}.title`);
  const Icon = step.done ? CircleCheck : Circle;

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        gap: 2,
        paddingBlock: 3,
        borderBlockStart: `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          color: step.done ? tokens['status.success'] : tokens['text.disabled'],
        }}
      >
        <Icon size={18} aria-hidden="true" />
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, fontSize: 13 }}>
        <Typography
          component="span"
          sx={{
            fontSize: 13,
            fontWeight: 500,
            color: step.done ? 'text.secondary' : 'text.primary',
            textDecoration: step.done ? 'line-through' : 'none',
          }}
        >
          {title}
          {step.optional ? (
            <Typography
              component="span"
              sx={{ fontSize: 12, fontWeight: 400, color: 'text.secondary', marginInlineStart: 1 }}
            >
              {t('admin:setupChecklist.optional')}
            </Typography>
          ) : null}
        </Typography>
        {step.done ? (
          <Box component="span" sx={visuallyHidden}>
            {t('admin:setupChecklist.stepDone')}
          </Box>
        ) : null}
        <Typography component="span" sx={{ fontSize: 13, color: 'text.secondary' }}>
          {t(`admin:setupChecklist.steps.${step.id}.why`)}
        </Typography>
      </Box>
      {step.done ? null : (
        <Link
          component={RouterLink}
          to={setupStepRoute(step.id)}
          onClick={onNavigate}
          aria-label={t('admin:setupChecklist.goTo', { step: title })}
          sx={{ marginInlineStart: 'auto', fontSize: 13, whiteSpace: 'nowrap' }}
        >
          {t('admin:setupChecklist.go')}
        </Link>
      )}
    </Box>
  );
}

function Panel({
  checklist,
  onClose,
  onHide,
}: {
  readonly checklist: SetupChecklist;
  readonly onClose: () => void;
  readonly onHide: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();
  const counts = { done: checklist.doneCount, total: checklist.total };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography id={headingId} component="h2" variant="h3">
          {t('admin:setupChecklist.title')}
        </Typography>
        <Box
          component="button"
          type="button"
          aria-label={t('admin:setupChecklist.close')}
          onClick={onClose}
          sx={{
            display: 'grid',
            placeItems: 'center',
            width: 28,
            height: 28,
            border: 0,
            borderRadius: '6px',
            backgroundColor: 'transparent',
            color: tokens['text.secondary'],
            cursor: 'pointer',
            '&:hover': { backgroundColor: tokens['bg.muted'] },
          }}
        >
          <X size={16} aria-hidden="true" />
        </Box>
      </Box>
      <Typography component="p" sx={{ fontSize: 13, color: 'text.secondary' }}>
        {t('admin:setupChecklist.progress', counts)}
      </Typography>
      <ProgressBar share={checklist.doneCount / checklist.total} />
      {checklist.complete ? (
        <Box
          role="status"
          sx={{
            display: 'flex',
            gap: 2,
            padding: 3,
            borderRadius: '6px',
            backgroundColor: tokens['status.success.tint'],
            color: tokens['status.success.text'],
            fontSize: 13,
            lineHeight: '20px',
          }}
        >
          <Check size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
          <span>{t('admin:setupChecklist.allDone')}</span>
        </Box>
      ) : (
        <>
          <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {checklist.steps.map((step) => (
              <StepRow key={step.id} step={step} onNavigate={onClose} />
            ))}
          </Box>
          <Box
            component="button"
            type="button"
            onClick={onHide}
            sx={{
              alignSelf: 'flex-start',
              minHeight: 28,
              border: 0,
              padding: 0,
              backgroundColor: 'transparent',
              color: tokens['text.secondary'],
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
              '&:hover': { color: tokens['text.primary'], textDecoration: 'underline' },
            }}
          >
            {t('admin:setupChecklist.hide')}
          </Box>
        </>
      )}
    </Box>
  );
}

/**
 * The "Get set up" entry at the foot of the sidebar and the panel it opens
 * (M14-13, `Admin/SetupChecklist`). Drawn for an Admin of the brand only
 * (D-31), and only while there is something to do: the api computes every step
 * from the brand's own data and says when the required ones are done, and the
 * entry then goes for everyone. A panel that is open when that happens stays
 * open to say so, and is gone when it is closed.
 *
 * Chrome, not a permission: the api refuses a caller without `brand:manage`
 * whatever this draws, and a refusal or a failed read simply draws nothing.
 */
export function SetupChecklistEntry(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const session = useSession();
  const api = useStaffApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const panelId = useId();
  const brand = currentBrand(session);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const key = setupChecklistKey(brand.id);

  const checklist = useQuery({
    queryKey: key,
    queryFn: () => api.setupChecklist(brand.id),
    enabled: session.user.role === 'admin',
    staleTime: CHECKLIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const hide = useMutation({
    mutationFn: () => api.dismissSetupChecklist(brand.id),
    onSuccess: (hidden) => {
      queryClient.setQueryData(key, hidden);
      setAnchor(null);
    },
    onError: () => {
      showToast({ message: t('admin:setupChecklist.hideFailed'), tone: 'danger' });
    },
  });

  const data = checklist.data;
  const open = anchor !== null;
  if (data === undefined || data.dismissed || (data.complete && !open)) {
    return null;
  }

  const counts = { done: data.doneCount, total: data.total };
  // MUI anchors by physical side, so the inline end is spelled per direction.
  const end = locale === 'ar' ? 'left' : 'right';
  const start = locale === 'ar' ? 'right' : 'left';

  return (
    <>
      <Box
        component="button"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('admin:setupChecklist.entryLabel', counts)}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          void queryClient.invalidateQueries({ queryKey: key });
        }}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          boxSizing: 'border-box',
          width: '100%',
          padding: 3,
          border: `1px solid ${tokens['border.default']}`,
          borderRadius: '6px',
          backgroundColor: tokens['bg.surface'],
          color: tokens['text.primary'],
          font: 'inherit',
          textAlign: 'start',
          cursor: 'pointer',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
        }}
      >
        <Box
          component="span"
          aria-hidden="true"
          sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 500 }}
        >
          {t('admin:setupChecklist.title')}
          <Box component="span" sx={{ color: tokens['text.secondary'], fontWeight: 400 }}>
            {t('admin:setupChecklist.entry', counts)}
          </Box>
        </Box>
        <ProgressBar share={data.doneCount / data.total} />
      </Box>
      <Popover
        id={panelId}
        open={open}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: end }}
        transformOrigin={{ vertical: 'bottom', horizontal: start }}
        slotProps={{
          paper: {
            role: 'dialog',
            'aria-label': t('admin:setupChecklist.title'),
            sx: {
              width: PANEL_WIDTH,
              maxWidth: 'calc(100vw - 32px)',
              boxSizing: 'border-box',
              padding: 6,
              marginInlineStart: 1,
              borderRadius: '10px',
            },
          },
        }}
      >
        <Panel
          checklist={data}
          onClose={() => {
            setAnchor(null);
          }}
          onHide={() => {
            hide.mutate();
          }}
        />
      </Popover>
    </>
  );
}
