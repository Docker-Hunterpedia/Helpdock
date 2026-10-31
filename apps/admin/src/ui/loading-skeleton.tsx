import { Box, Skeleton } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §4 Skeleton for a list or settings region while its first read is
 * out (`Admin/Empty-States`, "skeleton"): a title bar, then rows of an
 * avatar block over two text lines. The drawing is hidden from assistive
 * technology; the region around it says it is busy and what it is loading.
 */
export function LoadingSkeleton({
  rows = 4,
  label,
}: {
  readonly rows?: number;
  /** What is loading, already translated. Defaults to a plain "Loading". */
  readonly label?: string | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const keys = Array.from({ length: rows }, (_, row) => `row-${row}`);

  return (
    <Box
      role="status"
      aria-busy="true"
      aria-label={label ?? t('common:loading')}
      sx={{ display: 'flex', flexDirection: 'column' }}
    >
      <Box aria-hidden="true">
        <Skeleton variant="text" width="40%" height={16} />
        <Box sx={{ blockSize: 12 }} />
        {keys.map((key) => (
          <Box
            key={key}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              paddingBlock: '10px',
              borderBlockStart: `1px solid ${tokens['bg.muted']}`,
            }}
          >
            <Skeleton variant="rounded" width={32} height={32} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Skeleton variant="text" width="60%" height={12} />
              <Skeleton variant="text" width="35%" height={10} />
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
