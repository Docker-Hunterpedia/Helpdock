import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../../../../app/tokens.js';

/**
 * A catalog sentence that names variables and permissions between backticks —
 * "set with `HD_META_APP_ID`" — drawn the way the artboards draw them: mono on
 * `bg.muted`, left to right whatever the page's direction is. The backticks
 * are the only markup the Meta catalogs use, so a translator moves the code
 * with the sentence instead of splitting it across keys.
 */
export function CodeText({ text }: { readonly text: string }): ReactNode {
  const tokens = useSemanticTokens();
  const parts = text.split('`');

  return (
    <>
      {parts.map((part, index) =>
        // An odd index sits between two backticks.
        index % 2 === 1 ? (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one string
            key={index}
            component="code"
            dir="ltr"
            sx={{
              fontFamily: 'var(--hd-font-mono, monospace)',
              fontSize: '0.92em',
              backgroundColor: tokens['bg.muted'],
              paddingInline: 1,
              borderRadius: '4px',
              unicodeBidi: 'isolate',
              overflowWrap: 'anywhere',
            }}
          >
            {part}
          </Box>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one string
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}
