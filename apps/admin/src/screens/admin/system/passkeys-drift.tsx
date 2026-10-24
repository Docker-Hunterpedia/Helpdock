import { Link } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { SETTINGS_PASSKEYS_QUERY_KEY } from '../../../settings/api.js';
import { useSettingsApi } from '../../../settings/context.tsx';
import { PasskeysDriftBanner } from '../settings/passkeys-drift-banner.tsx';

/**
 * The warning Settings › Authentication shows when the install's address moved
 * away from the one its passkeys were made for (M18-06), repeated on the System
 * page where an operator looks first. It draws nothing when passkeys work, when
 * they are off, or when the status cannot be read.
 */
export function PasskeysDrift(): ReactNode {
  const t = useT();
  const api = useSettingsApi();
  const { data } = useQuery({
    queryKey: SETTINGS_PASSKEYS_QUERY_KEY,
    queryFn: () => api.passkeys(),
    retry: false,
  });

  if (data?.state !== 'paused' || data.pinnedRpId === null || data.rpId === null) {
    return null;
  }

  return (
    <PasskeysDriftBanner from={data.pinnedRpId} to={data.rpId}>
      {' '}
      <Link component={RouterLink} to={ROUTES.settings}>
        {t('system:passkeysDrift.link')}
      </Link>
    </PasskeysDriftBanner>
  );
}
