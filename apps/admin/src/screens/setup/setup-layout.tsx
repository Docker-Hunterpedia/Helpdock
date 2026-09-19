import { Box, Link, Paper, Typography } from '@mui/material';
import { Check, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { BrandMark } from '../../ui/brand-mark.tsx';
import { SETUP_STEPS, type SetupStep, stepsRemaining } from './setup-state.js';

/**
 * The chrome of the artboard `Admin/Wizard`: the mark and title, the four-step
 * progress list, a 720 px card for the step in hand, and the master-key note
 * under it.
 *
 * Nothing here knows what a step does. Each step renders its own heading,
 * fields and footer inside {@link SetupLayout}'s card, so adding the LLM
 * provider step (M7-10) is one entry in `SETUP_STEPS` and one component.
 */

/** Where the note's link goes. The repository is the docs' only home for now. */
export const OPERATIONS_GUIDE_URL =
  'https://github.com/Docker-Hunterpedia/Helpdock/blob/main/docs/guides/operations.md#the-master-key';

const CARD_WIDTH = 720;

/** DESIGN §6.2: a 4 px bar per step, teal once done, grey until then. */
function StepBar({ state }: { readonly state: 'done' | 'current' | 'later' }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      aria-hidden="true"
      sx={{
        height: 4,
        borderRadius: 2,
        backgroundColor: state === 'later' ? tokens['border.default'] : tokens['action.primary'],
        opacity: state === 'current' ? 0.5 : 1,
      }}
    />
  );
}

export function SetupProgress({ current }: { readonly current: SetupStep }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const currentIndex = SETUP_STEPS.indexOf(current);

  return (
    <Box
      component="nav"
      aria-label={t('wizard:progressLabel')}
      sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <Box
        component="ol"
        sx={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${String(SETUP_STEPS.length)}, 1fr)`,
          gap: 3,
        }}
      >
        {SETUP_STEPS.map((step, index) => {
          const state =
            index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'later';

          return (
            <Box
              component="li"
              key={step}
              {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
              sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <StepBar state={state} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {state === 'done' ? (
                  <Check
                    size={14}
                    aria-hidden="true"
                    color={tokens['action.primary']}
                    style={{ flexShrink: 0 }}
                  />
                ) : null}
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: state === 'current' ? 600 : 400,
                    // Not `text.disabled` for a step that is merely later: it
                    // is 2.3:1 on the canvas, and a label nobody can read is
                    // not a label (DESIGN §10). The bars and the tick carry
                    // the state; the weight says which step is in hand.
                    color: state === 'current' ? 'text.primary' : 'text.secondary',
                  }}
                >
                  {t('wizard:stepLabel', {
                    index: index + 1,
                    label: t(`wizard:steps.${step}`),
                  })}
                  {/* The tick is decorative, so "done" is also said in words. */}
                  {state === 'done' ? (
                    <Box component="span" sx={visuallyHidden}>
                      {` ${t('wizard:stepDone')}`}
                    </Box>
                  ) : null}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('wizard:stepsRemaining', { count: stepsRemaining(current) })}
      </Typography>
    </Box>
  );
}

/** Off screen, still read aloud. The one place the admin needs it so far. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

function MasterKeyNote(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 3,
        alignItems: 'flex-start',
        padding: '12px 16px',
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Lock size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
          {t('wizard:masterKey.title')}
        </Box>{' '}
        {t('wizard:masterKey.body', { envKey: 'APP_MASTER_KEY', envFile: '.env' })}{' '}
        <Link href={OPERATIONS_GUIDE_URL} target="_blank" rel="noreferrer">
          {t('wizard:masterKey.link')}
        </Link>
      </Typography>
    </Box>
  );
}

export interface SetupLayoutProps {
  readonly step: SetupStep;
  /** `v0.1.0 · api + worker healthy`, built by the page from the meta tag and `/ready`. */
  readonly systemStatus: string;
  readonly children: ReactNode;
}

export function SetupLayout({ step, systemStatus, children }: SetupLayoutProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        backgroundColor: tokens['bg.canvas'],
        display: 'flex',
        justifyContent: 'center',
        padding: 6,
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: CARD_WIDTH,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            flexWrap: 'wrap',
          }}
        >
          <BrandMark initial="H" />
          <Typography variant="h3" component="h1" sx={{ flexGrow: 1 }}>
            {t('wizard:title')}
          </Typography>
          <Typography variant="mono" component="p" dir="ltr" sx={{ color: 'text.secondary' }}>
            {systemStatus}
          </Typography>
        </Box>

        <SetupProgress current={step} />

        <Paper
          elevation={0}
          sx={{
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
            padding: 6,
          }}
        >
          {children}
        </Paper>

        <MasterKeyNote />
      </Box>
    </Box>
  );
}

export interface StepFrameProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  /** The row of buttons at the foot of the card. */
  readonly footer: ReactNode;
  readonly onSubmit?: (() => void) | undefined;
}

/** Heading, caption, fields, footer: the shape every step's card shares. */
export function StepFrame({
  title,
  description,
  children,
  footer,
  onSubmit,
}: StepFrameProps): ReactNode {
  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="h1" component="h2">
          {title}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {description}
        </Typography>
      </Box>

      {children}

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 3,
          flexWrap: 'wrap',
        }}
      >
        {footer}
      </Box>
    </Box>
  );
}
