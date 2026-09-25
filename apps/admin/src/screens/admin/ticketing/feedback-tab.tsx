import type { BrandSettings } from '@helpdock/schemas';
import { Box, Button, Checkbox, FormControlLabel, Link, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { csatPreviewRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/**
 * The Feedback tab of `Admin/Ticketing` (`AdminTicketingFeedback`, M1-12): the
 * brand's CSAT toggle, its time tracking toggle, and whether the per-reply
 * timer starts with the composer.
 *
 * One form and one save, as drawn: three checkboxes are one decision about how
 * the desk works, and saving each as it is ticked would make "Discard"
 * meaningless. The composer toggle is indented under time tracking and
 * disabled while tracking is off, because a timer nobody sees cannot start.
 *
 * "Preview" (M1-15 part 2) opens the rating page over a sample in a new tab
 * (`csat/preview-api.ts`): no token, no ticket, and nothing it sends is kept.
 */

type FeedbackDraft = Pick<
  BrandSettings,
  'csatEnabled' | 'timeTrackingEnabled' | 'timerStartsWithComposer'
>;

const draftOf = (settings: BrandSettings): FeedbackDraft => ({
  csatEnabled: settings.csatEnabled,
  timeTrackingEnabled: settings.timeTrackingEnabled,
  timerStartsWithComposer: settings.timerStartsWithComposer,
});

export function FeedbackTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const brand = currentBrand(session);
  const { locale } = usePreferences();

  const brandQuery = useQuery({
    queryKey: ['brand', brand.id],
    queryFn: () => api.brand(brand.id),
  });

  const stored = brandQuery.data?.settings;
  const [draft, setDraft] = useState<FeedbackDraft | null>(null);

  // Re-filled when the stored settings change under the form — after a save,
  // or after another tab wrote them — and not on every click.
  useEffect(() => {
    if (stored !== undefined) {
      setDraft(draftOf(stored));
    }
  }, [stored]);

  const save = useTicketingAction(
    (next: FeedbackDraft) => api.updateFeedback(brand.id, next),
    () => t('ticketing:toast.feedbackSaved'),
    async () => {
      await queryClient.invalidateQueries({ queryKey: ['brand', brand.id] });
    },
    report,
  );

  if (stored === undefined || draft === null) {
    return <Box aria-busy="true" />;
  }

  const changed =
    draft.csatEnabled !== stored.csatEnabled ||
    draft.timeTrackingEnabled !== stored.timeTrackingEnabled ||
    draft.timerStartsWithComposer !== stored.timerStartsWithComposer;

  const set = (patch: Partial<FeedbackDraft>): void => {
    setDraft({ ...draft, ...patch });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate(draft);
  };

  const card = {
    borderRadius: '10px',
    border: `1px solid ${tokens['border.default']}`,
    backgroundColor: tokens['bg.surface'],
  } as const;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 820px) 300px' },
        gap: 8,
        alignItems: 'start',
      }}
    >
      <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Box>
          <Typography variant="h3" component="h2">
            {t('ticketing:feedback.heading')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:feedback.caption')}
          </Typography>
        </Box>

        <Box
          component="form"
          onSubmit={submit}
          aria-label={t('ticketing:feedback.form')}
          sx={{ ...card, display: 'flex', flexDirection: 'column' }}
        >
          <Box
            sx={{
              padding: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              borderBlockEnd: `1px solid ${tokens['border.default']}`,
            }}
          >
            <Typography variant="bodyStrong" component="h3">
              {t('ticketing:feedback.csatHeading')}
            </Typography>
            <Toggle
              checked={draft.csatEnabled}
              label={t('ticketing:feedback.csatEnabled')}
              hint={t('ticketing:feedback.csatHint')}
              onChange={(csatEnabled) => {
                set({ csatEnabled });
              }}
            />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, paddingInlineStart: 7 }}>
              <Typography variant="body2" component="h4" sx={{ fontWeight: 500 }}>
                {t('ticketing:feedback.previewHeading')}
              </Typography>
              <Link
                href={csatPreviewRoute(locale)}
                target="_blank"
                rel="noopener"
                variant="body2"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 1,
                  alignSelf: 'flex-start',
                }}
              >
                <Eye size={14} aria-hidden="true" />
                {t('ticketing:feedback.previewLink')}
                <Box component="span" sx={visuallyHidden}>
                  {` ${t('ticketing:feedback.previewNewTab')}`}
                </Box>
              </Link>
            </Box>
          </Box>

          <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Typography variant="bodyStrong" component="h3">
              {t('ticketing:feedback.timeHeading')}
            </Typography>
            <Toggle
              checked={draft.timeTrackingEnabled}
              label={t('ticketing:feedback.timeEnabled')}
              hint={t('ticketing:feedback.timeHint')}
              onChange={(timeTrackingEnabled) => {
                set({ timeTrackingEnabled });
              }}
            />
            <Box sx={{ paddingInlineStart: 7 }}>
              <Toggle
                checked={draft.timerStartsWithComposer}
                disabled={!draft.timeTrackingEnabled}
                label={t('ticketing:feedback.timerWithComposer')}
                hint={t('ticketing:feedback.timerHint')}
                onChange={(timerStartsWithComposer) => {
                  set({ timerStartsWithComposer });
                }}
              />
            </Box>
          </Box>

          <Box
            sx={{
              paddingBlock: 3,
              paddingInline: 5,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 2,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              borderEndStartRadius: '10px',
              borderEndEndRadius: '10px',
            }}
          >
            <Button
              variant="text"
              disabled={!changed || save.isPending}
              onClick={() => {
                setDraft(draftOf(stored));
              }}
            >
              {t('ticketing:feedback.discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={!changed || save.isPending}>
              {t('ticketing:feedback.save')}
            </Button>
          </Box>
        </Box>
      </Box>

      <Box component="aside" sx={{ ...card, paddingBlock: 3, paddingInline: 4 }}>
        <Typography variant="bodyStrong" component="h3">
          {t('ticketing:feedback.deliveryHeading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', marginBlockStart: 2 }}>
          {t('ticketing:feedback.deliveryBody')}
        </Typography>
      </Box>
    </Box>
  );
}

function Toggle({
  checked,
  disabled = false,
  label,
  hint,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly hint: string;
  onChange(checked: boolean): void;
}): ReactNode {
  return (
    <FormControlLabel
      disabled={disabled}
      sx={{ alignItems: 'flex-start', marginInline: 0, gap: 1 }}
      control={
        <Checkbox
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
          sx={{ paddingBlock: 0 }}
        />
      }
      label={
        <Box component="span" sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography component="span" variant="bodyStrong">
            {label}
          </Typography>
          <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>
            {hint}
          </Typography>
        </Box>
      }
    />
  );
}

/** Read aloud, drawn as nothing. Sizes as strings: MUI reads a bare `1` as `100%`. */
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const;
