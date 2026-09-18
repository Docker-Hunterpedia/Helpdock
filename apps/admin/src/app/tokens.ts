import { resolveSemanticTokens, type SemanticTokens } from '@helpdock/ui';
import { useMemo } from 'react';
import { usePreferences } from './providers.tsx';

/**
 * The DESIGN §2.2 tokens for the mode in force. The MUI palette carries the
 * handful it has a slot for; everything else — `bg.muted`, `border.strong`, the
 * status tints — is read from here rather than written as a hex anywhere.
 */
export function useSemanticTokens(): SemanticTokens {
  const { mode } = usePreferences();

  return useMemo(() => resolveSemanticTokens(mode), [mode]);
}
