import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.2 Tag in the `sand` tint and mono 12: an API key scope or a
 * webhook event (SecretReveal, §6.4). Left-to-right inside the Arabic layout,
 * because `tickets:read` is an identifier, not prose.
 */
export function MonoTag({
  children,
  muted = false,
  prose = false,
}: {
  readonly children: ReactNode;
  /** A revoked key's scopes: the same tag, its text receding. */
  readonly muted?: boolean;
  /** Words rather than an identifier ("All 7 events"): the reader's font and direction. */
  readonly prose?: boolean;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="span"
      dir={prose ? undefined : 'ltr'}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        blockSize: 22,
        paddingInline: 2,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.canvas'],
        color: muted ? tokens['text.secondary'] : tokens['text.primary'],
        ...(prose ? {} : { fontFamily: 'var(--hd-font-mono, monospace)' }),
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  );
}

export function MonoTags({
  values,
  label,
  muted = false,
}: {
  readonly values: readonly string[];
  /** Names the list for a screen reader: "Scopes". */
  readonly label?: string;
  readonly muted?: boolean;
}): ReactNode {
  return (
    <Box
      component="ul"
      aria-label={label}
      sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 1 }}
    >
      {values.map((value) => (
        <li key={value}>
          <MonoTag muted={muted}>{value}</MonoTag>
        </li>
      ))}
    </Box>
  );
}
