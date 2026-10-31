import { Box, Skeleton } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../../app/tokens.js';
import { MESSAGE_MAX_WIDTH } from './message-bubble.tsx';

/**
 * DESIGN §6.3 Skeleton for the two busiest screens while their first
 * read is out: the shapes of what is coming, so the layout does not jump when
 * it lands. They are drawings, hidden from assistive technology; the container
 * they sit in says it is busy.
 */

/** About one first screen of the 64 px side list at 720 px tall. */
export const LIST_SKELETON_ROWS = 6;

const ROW_KEYS = Array.from({ length: LIST_SKELETON_ROWS }, (_, row) => `row-${row}`);

/** TicketRow's anatomy: the priority dot, two lines, the assignee circle at the inline end. */
export function TicketListSkeleton(): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box aria-hidden="true">
      {ROW_KEYS.map((key) => (
        <Box
          key={key}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            height: 64,
            paddingInline: 4,
            borderBlockEnd: `1px solid ${tokens['border.default']}`,
            borderInlineStart: '3px solid transparent',
          }}
        >
          <Skeleton variant="circular" width={8} height={8} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Skeleton variant="text" width="70%" />
            <Skeleton variant="text" width="40%" />
          </Box>
          <Skeleton variant="circular" width={24} height={24} />
        </Box>
      ))}
    </Box>
  );
}

/** The ticket header, then a contact message and a reply. */
export function TicketViewSkeleton(): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box aria-hidden="true">
      <Box
        sx={{
          padding: 4,
          backgroundColor: tokens['bg.surface'],
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Skeleton variant="text" width={64} />
        <Skeleton variant="text" width="60%" height={32} />
        <Skeleton variant="rounded" width={200} height={20} sx={{ marginBlockStart: 2 }} />
      </Box>
      <Box
        sx={{
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Skeleton
          variant="rounded"
          height={96}
          sx={{ width: '70%', maxWidth: MESSAGE_MAX_WIDTH, alignSelf: 'flex-start' }}
        />
        <Skeleton
          variant="rounded"
          height={72}
          sx={{ width: '60%', maxWidth: MESSAGE_MAX_WIDTH, alignSelf: 'flex-end' }}
        />
      </Box>
    </Box>
  );
}
