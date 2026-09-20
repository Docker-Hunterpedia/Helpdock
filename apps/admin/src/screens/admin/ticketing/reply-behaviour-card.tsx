import type { BrandSettings, ReopenPolicy } from '@helpdock/schemas';
import { REOPEN_WITHIN_DAYS_DEFAULT, REOPEN_WITHIN_DAYS_MAX } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The "Reply behaviour" card under the statuses table: the two settings
 * DOMAIN-RULES §2.3 lets a Team Leader change.
 *
 * The day count is only shown for `within_days`, because a number beside
 * "Always reopen" is a number that does nothing — and a control that does
 * nothing is a control somebody will set and then be surprised by. The value is
 * kept in state while another policy is selected, so flipping back does not
 * lose what was typed.
 */
export function ReplyBehaviourCard({
  settings,
  busy,
  onSave,
}: {
  readonly settings: BrandSettings;
  readonly busy: boolean;
  onSave(next: { autoAwaitOnAgentReply: boolean; reopenPolicy: ReopenPolicy }): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const policyId = useId();
  const daysId = useId();

  const [autoAwait, setAutoAwait] = useState(settings.autoAwaitOnAgentReply);
  const [kind, setKind] = useState<ReopenPolicy['kind']>(settings.reopenPolicy.kind);
  const [days, setDays] = useState(
    settings.reopenPolicy.kind === 'within_days'
      ? settings.reopenPolicy.days
      : REOPEN_WITHIN_DAYS_DEFAULT,
  );

  // The card re-fills when the brand's stored settings change under it — after
  // a save, or after another tab wrote them — and not on every keystroke.
  useEffect(() => {
    setAutoAwait(settings.autoAwaitOnAgentReply);
    setKind(settings.reopenPolicy.kind);
    if (settings.reopenPolicy.kind === 'within_days') {
      setDays(settings.reopenPolicy.days);
    }
  }, [settings]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    onSave({
      autoAwaitOnAgentReply: autoAwait,
      reopenPolicy: kind === 'within_days' ? { kind, days } : { kind },
    });
  };

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={t('ticketing:statuses.reply.heading')}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 5,
        marginBlockStart: 6,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2">
        {t('ticketing:statuses.reply.heading')}
      </Typography>

      <Box>
        <FormControlLabel
          control={
            <Checkbox
              checked={autoAwait}
              onChange={(event) => {
                setAutoAwait(event.target.checked);
              }}
            />
          }
          label={t('ticketing:statuses.reply.autoAwait')}
        />
        <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
          {t('ticketing:statuses.reply.autoAwaitHint')}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Typography component="span" id={`${policyId}-label`}>
          {t('ticketing:statuses.reply.reopen')}
        </Typography>

        <Select
          id={policyId}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ReopenPolicy['kind']);
          }}
          size="small"
          inputProps={{ 'aria-label': t('ticketing:statuses.reply.reopen') }}
        >
          <MenuItem value="within_days">{t('ticketing:statuses.reply.reopenWithin')}</MenuItem>
          <MenuItem value="always">{t('ticketing:statuses.reply.reopenAlways')}</MenuItem>
          <MenuItem value="never">{t('ticketing:statuses.reply.reopenNever')}</MenuItem>
        </Select>

        {kind === 'within_days' ? (
          <>
            <TextField
              id={daysId}
              type="number"
              value={days}
              onChange={(event) => {
                setDays(Number(event.target.value));
              }}
              size="small"
              sx={{ inlineSize: 88 }}
              slotProps={{
                htmlInput: {
                  min: 1,
                  max: REOPEN_WITHIN_DAYS_MAX,
                  'aria-label': t('ticketing:statuses.reply.daysLabel'),
                },
              }}
            />
            <Typography component="span">{t('ticketing:statuses.reply.days')}</Typography>
          </>
        ) : null}
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="submit"
          variant="contained"
          disabled={busy || (kind === 'within_days' && (days < 1 || days > REOPEN_WITHIN_DAYS_MAX))}
        >
          {t('ticketing:statuses.reply.save')}
        </Button>
      </Box>
    </Box>
  );
}
