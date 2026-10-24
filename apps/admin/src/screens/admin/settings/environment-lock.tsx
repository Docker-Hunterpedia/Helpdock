import { Chip } from '@mui/material';
import { LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';

/** The "Set by environment" badge of a setting an `HD_*` key pins. */
export function EnvironmentLock(): ReactNode {
  const t = useT();
  return (
    <Chip
      size="small"
      icon={<LockKeyhole size={12} aria-hidden="true" />}
      label={t('settings:lock.badge')}
    />
  );
}
