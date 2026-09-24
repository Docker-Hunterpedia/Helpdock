import type { CsatSubmitRequest, CsatSurveyView } from '@helpdock/schemas';
import { CSAT_COMMENT_MAX } from '@helpdock/schemas';
import type { SemanticTokens } from '@helpdock/ui';
import { Box, Button, TextField, Typography } from '@mui/material';
import { Check, Clock, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import type { LoadState } from './csat-app.tsx';

/**
 * What the rating page draws (`CsatEN`, `CsatAR`): the form while the link is
 * open, the thanks once it is used, and one sentence when it is spent.
 *
 * - The five ratings are **toggle buttons with `aria-pressed`**, 64 px high —
 *   above the 44 px customer-facing minimum of DESIGN §10 — rather than
 *   radios, as the artboard notes.
 * - **Expired and used share one screen**: no form, one sentence, and nothing
 *   about the ticket. A link the api does not recognise draws the same screen,
 *   so a mistyped or forged link learns nothing either.
 * - The ticket reference is wrapped in `<bdi>` so it reads left to right inside
 *   Arabic (DESIGN §3.2).
 *
 * The artboard's "closed by Lina" and "Browse the help center" are left out:
 * DOMAIN-RULES §4.6 gives the link nothing beyond its purpose, so the api does
 * not send an agent's name, and there is no help center to link to until M5.
 */

/** The five buttons, each with the catalog key of its word. */
const RATING_LABELS = {
  1: 'csat:ratings.1',
  2: 'csat:ratings.2',
  3: 'csat:ratings.3',
  4: 'csat:ratings.4',
  5: 'csat:ratings.5',
} as const satisfies Record<number, string>;

type Rating = keyof typeof RATING_LABELS;

const RATINGS: readonly Rating[] = [1, 2, 3, 4, 5];

const ratingLabel = (rating: number) => RATING_LABELS[rating as Rating];

export function CsatPage({
  tokens,
  brandName,
  state,
  onRate,
}: {
  readonly tokens: SemanticTokens;
  readonly brandName: string | null;
  readonly state: LoadState;
  onRate(request: CsatSubmitRequest): Promise<CsatSurveyView>;
}): ReactNode {
  const t = useT();
  const [answer, setAnswer] = useState<CsatSurveyView | null>(null);
  const view = answer ?? (state.kind === 'ready' ? state.view : null);

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlock: { xs: 4, sm: 12 },
        paddingInline: 4,
        backgroundColor: tokens['bg.canvas'],
        fontSize: 16,
        lineHeight: '24px',
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 560,
          padding: { xs: 5, sm: 8 },
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {brandName === null ? null : <BrandHeader name={brandName} tokens={tokens} />}

        {state.kind === 'loading' ? (
          <Box aria-busy="true" role="status">
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('csat:loading')}
            </Typography>
          </Box>
        ) : null}

        {state.kind === 'failed' ? (
          state.problem === 'not-found' ? (
            <Notice tone="warning" tokens={tokens}>
              {t('csat:spent')}
            </Notice>
          ) : (
            <Notice tone="danger" tokens={tokens}>
              {t('csat:unavailable')}
            </Notice>
          )
        ) : null}

        {view?.state === 'used' || view?.state === 'expired' ? (
          <Notice tone="warning" tokens={tokens}>
            {t('csat:spent')}
          </Notice>
        ) : null}

        {view?.state === 'rated' ? (
          <Rated rating={view.rating} brandName={view.brand.name} tokens={tokens} />
        ) : null}

        {view?.state === 'open' ? (
          <RatingForm
            reference={view.ticket.reference}
            subject={view.ticket.subject}
            tokens={tokens}
            onRate={async (request) => {
              setAnswer(await onRate(request));
            }}
          />
        ) : null}
      </Box>
    </Box>
  );
}

function BrandHeader({
  name,
  tokens,
}: {
  readonly name: string;
  readonly tokens: SemanticTokens;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box
        aria-hidden="true"
        sx={{
          width: 32,
          height: 32,
          borderRadius: '6px',
          display: 'grid',
          placeItems: 'center',
          fontWeight: 600,
          backgroundColor: tokens['action.primary'],
          color: tokens['action.primary.text'],
        }}
      >
        {name.slice(0, 1).toUpperCase()}
      </Box>
      <Typography component="span" sx={{ fontWeight: 600, fontSize: 16 }}>
        {name}
      </Typography>
    </Box>
  );
}

function RatingForm({
  reference,
  subject,
  tokens,
  onRate,
}: {
  readonly reference: string;
  readonly subject: string;
  readonly tokens: SemanticTokens;
  onRate(request: CsatSubmitRequest): Promise<void>;
}): ReactNode {
  const t = useT();
  const legendId = useId();
  const errorId = useId();
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (rating === null) {
      setMissing(true);
      return;
    }

    setSending(true);
    setFailed(false);
    try {
      const trimmed = comment.trim();
      await onRate({ rating, ...(trimmed === '' ? {} : { comment: trimmed }) });
    } catch {
      setFailed(true);
      setSending(false);
    }
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="h1" component="h1" sx={{ textWrap: 'pretty' }}>
          {t('csat:heading')}
        </Typography>
        <Typography sx={{ fontSize: 16, lineHeight: '24px', color: 'text.secondary' }}>
          <Typography component="bdi" variant="mono" sx={{ fontSize: 'inherit' }}>
            {reference}
          </Typography>
          {' · '}
          {subject}
        </Typography>
      </Box>

      <Box
        component="fieldset"
        aria-labelledby={legendId}
        aria-describedby={missing ? errorId : undefined}
        sx={{ margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        <Typography
          id={legendId}
          component="legend"
          sx={{ fontSize: 14, fontWeight: 500, padding: 0 }}
        >
          {t('csat:ratingLegend')}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 2 }}>
          {RATINGS.map((value) => {
            const pressed = rating === value;

            return (
              <Button
                key={value}
                type="button"
                aria-pressed={pressed}
                onClick={() => {
                  setRating(value);
                  setMissing(false);
                }}
                sx={{
                  height: 64,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                  borderRadius: '6px',
                  border: pressed
                    ? `2px solid ${tokens['action.primary']}`
                    : `1px solid ${tokens['border.strong']}`,
                  backgroundColor: pressed ? tokens['action.primary.tint'] : tokens['bg.surface'],
                  color: tokens['text.primary'],
                  '&:hover': {
                    backgroundColor: pressed ? tokens['action.primary.tint'] : tokens['bg.muted'],
                  },
                }}
              >
                <Typography component="span" variant="mono" sx={{ fontSize: 20, fontWeight: 500 }}>
                  {value}
                </Typography>
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ color: pressed ? 'text.primary' : 'text.secondary' }}
                >
                  {t(RATING_LABELS[value])}
                </Typography>
              </Button>
            );
          })}
        </Box>
        {missing ? (
          <Typography id={errorId} role="alert" variant="caption" sx={{ color: 'error.main' }}>
            {t('csat:chooseRating')}
          </Typography>
        ) : null}
      </Box>

      <TextField
        multiline
        minRows={3}
        label={`${t('csat:comment')} ${t('csat:optional')}`}
        placeholder={t('csat:commentPlaceholder')}
        value={comment}
        onChange={(event) => {
          setComment(event.target.value);
        }}
        slotProps={{ htmlInput: { maxLength: CSAT_COMMENT_MAX } }}
      />

      {failed ? (
        <Notice tone="danger" tokens={tokens}>
          {t('csat:failed')}
        </Notice>
      ) : null}

      <Button type="submit" variant="contained" size="large" disabled={sending}>
        {t('csat:submit')}
      </Button>

      <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
        {t('csat:footnote')}
      </Typography>
    </Box>
  );
}

function Rated({
  rating,
  brandName,
  tokens,
}: {
  readonly rating: number;
  readonly brandName: string;
  readonly tokens: SemanticTokens;
}): ReactNode {
  const t = useT();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Notice tone="success" tokens={tokens}>
        {t('csat:thanks')}
      </Notice>
      <Typography variant="h2" component="h1">
        {t('csat:ratedHeading', { rating, label: t(ratingLabel(rating)) })}
      </Typography>
      <Typography sx={{ fontSize: 16, lineHeight: '24px', color: 'text.secondary' }}>
        {t('csat:ratedBody', { brand: brandName })}
      </Typography>
    </Box>
  );
}

const NOTICE_ICON = { success: Check, warning: Clock, danger: TriangleAlert } as const;

function Notice({
  tone,
  tokens,
  children,
}: {
  readonly tone: 'success' | 'warning' | 'danger';
  readonly tokens: SemanticTokens;
  readonly children: ReactNode;
}): ReactNode {
  const Icon = NOTICE_ICON[tone];

  return (
    <Box
      role={tone === 'success' ? 'status' : 'alert'}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        paddingBlock: '10px',
        paddingInline: 3,
        borderRadius: '6px',
        backgroundColor: tokens[`status.${tone}.tint`],
        border: `1px solid ${tokens[`status.${tone}`]}`,
        color: tokens[`status.${tone}.text`],
        fontSize: 14,
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
      <Typography component="p" sx={{ fontSize: 14, color: 'inherit' }}>
        {children}
      </Typography>
    </Box>
  );
}
