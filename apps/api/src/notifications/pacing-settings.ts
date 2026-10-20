import type { Settings } from '@helpdock/config';
import { type PacingConfig, pacingConfigFromMinutes } from './email-pacing.js';

/**
 * The `notify.email.*` install settings (`HD_NOTIFY_EMAIL_*` overrides), read
 * each time a job needs them, so an operator who changes one needs no
 * restart.
 */
export const readPacingConfig = async (settings: Pick<Settings, 'get'>): Promise<PacingConfig> => {
  const [
    firstWaitMinutes,
    backoffMinutes,
    quietResetMinutes,
    urgentIntervalMinutes,
    urgentPerDay,
    perHour,
    perDay,
  ] = await Promise.all([
    settings.get('notify.email.firstWaitMinutes'),
    settings.get('notify.email.backoffMinutes'),
    settings.get('notify.email.quietResetMinutes'),
    settings.get('notify.email.urgentIntervalMinutes'),
    settings.get('notify.email.urgentPerDay'),
    settings.get('notify.email.perHour'),
    settings.get('notify.email.perDay'),
  ]);

  return pacingConfigFromMinutes({
    firstWaitMinutes,
    backoffMinutes,
    quietResetMinutes,
    urgentIntervalMinutes,
    urgentPerDay,
    perHour,
    perDay,
  });
};
