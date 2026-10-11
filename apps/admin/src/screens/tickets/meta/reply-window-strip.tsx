import type { MetaPlatform } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { Ban, Clock, UserCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans } from 'react-i18next';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { agoLabel, closesWhen, windowLeft } from './meta-format.js';
import type { StripState } from './reply-window.js';

/**
 * DESIGN §6.3 ReplyWindowStrip (M10-06, M10-08, `Admin/Ticket-Meta` panel 4): the
 * reply window of a WhatsApp, Messenger or Instagram ticket, between the thread
 * and the composer, in the AIPausedStrip's family.
 *
 * - **Open**: neutral, `Clock`, how long is left and when it closes.
 * - **Closing**, the open strip in its last hour: the warning tone.
 * - **Human Agent**: neutral, `UserCheck`, the days left; only a person's reply
 *   may use them.
 * - **Closed**: the warning tone, `Ban`, when it closed and what that means. A
 *   closed window is waiting on the customer, as Awaiting customer is, so it is
 *   a warning and never a danger.
 * - **Refused at Send**: closed, with a second line saying the text was kept.
 *
 * The strip is the one `role="status"` outside the thread, so it speaks when its
 * state changes. Its countdown is `aria-hidden` and moves once a minute (the
 * caller's clock); what is read is the state and the closing time in a
 * `<time>`, so a screen reader hears the strip when it changes and not every
 * minute.
 */
export function ReplyWindowStrip({
  id,
  state,
  platform,
  customerName,
  now,
}: {
  /** What Send's `aria-describedby` names. */
  readonly id: string;
  readonly state: StripState;
  readonly platform: MetaPlatform;
  /** The contact's name, or "the customer". */
  readonly customerName: string;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const warning = state.kind === 'closing' || state.kind === 'closed';
  const Icon = state.kind === 'humanAgent' ? UserCheck : state.kind === 'closed' ? Ban : Clock;
  const platformName = t(`tickets:channel.${platform}`);

  const strong = (
    <Box
      component="strong"
      sx={{ fontWeight: 600, color: warning ? 'inherit' : tokens['text.primary'] }}
    />
  );
  const mono = <Typography variant="mono" component="span" sx={{ fontSize: 13 }} />;
  const components = { b: strong, mono, count: <span aria-hidden="true" />, bdi: <bdi /> };

  const timeOf = (iso: string): ReactNode => (
    <Typography variant="mono" component="time" dateTime={iso} sx={{ fontSize: 13 }} />
  );

  return (
    <Box
      id={id}
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 3,
        padding: '8px 12px',
        borderRadius: '6px',
        backgroundColor: warning ? tokens['status.warning.tint'] : tokens['bg.muted'],
        border: `1px solid ${warning ? tokens['status.warning'] : tokens['border.default']}`,
        color: warning ? tokens['status.warning.text'] : 'text.secondary',
        fontSize: 13,
        lineHeight: '20px',
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          display: 'inline-flex',
          // The 16 px icon sits on the first line's centre.
          height: 20,
          alignItems: 'center',
          color: warning ? tokens['status.warning'] : 'inherit',
        }}
      >
        <Icon size={16} />
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        {state.kind === 'closed' ? (
          <>
            <Box component="p" sx={{ margin: 0 }}>
              <Trans i18nKey="tickets:meta.window.closed" components={components} />
              {' · '}
              {state.closedAt === null ? (
                t('tickets:meta.window.neverWrote', { name: customerName })
              ) : (
                <Trans
                  i18nKey="tickets:meta.window.closedAt"
                  values={{
                    ago: agoLabel(state.closedAt, locale, now),
                    when: closesWhen(state.closedAt, locale, now, t),
                  }}
                  components={{ time: timeOf(state.closedAt) }}
                />
              )}{' '}
              {t('tickets:meta.window.rule', { platform: platformName, name: customerName })}
              {platform === 'whatsapp' ? null : ` ${t('tickets:meta.window.note')}`}
            </Box>
            {state.refused ? (
              <Box component="p" sx={{ margin: 0, marginBlockStart: 1 }}>
                <Trans
                  i18nKey="tickets:meta.window.refusedAtSend"
                  values={{
                    name: customerName,
                    when: state.closedAt === null ? '' : closesWhen(state.closedAt, locale, now, t),
                  }}
                  components={{ ...components, time: timeOf(state.closedAt ?? '') }}
                />
              </Box>
            ) : null}
          </>
        ) : (
          <Trans
            i18nKey={`tickets:meta.window.${state.kind}`}
            values={{
              left: windowLeft(state.closesAt, now, t),
              when: closesWhen(state.closesAt, locale, now, t),
            }}
            components={{ ...components, time: timeOf(state.closesAt) }}
          />
        )}
      </Box>

      {state.kind === 'open' || state.kind === 'humanAgent' ? (
        <Typography
          variant="caption"
          sx={{ flexShrink: 0, maxWidth: '40%', color: tokens['text.secondary'], textAlign: 'end' }}
        >
          {t(
            state.kind === 'open'
              ? 'tickets:meta.window.caption'
              : 'tickets:meta.window.captionHumanAgent',
            { platform: platformName },
          )}
        </Typography>
      ) : null}
    </Box>
  );
}
