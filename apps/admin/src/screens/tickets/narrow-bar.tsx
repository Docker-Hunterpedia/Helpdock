import { Box, Button } from '@mui/material';
import { ChevronLeft, PanelRightOpen } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { visuallyHidden } from '../../ui/visually-hidden.js';

/**
 * The bar over a pushed ticket below 1024 px (`Admin/Tickets-Narrow`, M14-22):
 * Back, named for the view it returns to, and the button that opens the
 * details drawer. The arrow mirrors in right-to-left.
 */
export function NarrowBar({
  viewName,
  backRef,
  onBack,
  onDetails,
}: {
  readonly viewName: string;
  readonly backRef: Ref<HTMLButtonElement>;
  onBack(): void;
  onDetails(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        paddingBlock: 2,
        paddingInline: 3,
        backgroundColor: tokens['bg.surface'],
        borderBlockEnd: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box component="h1" sx={visuallyHidden}>
        {viewName}
      </Box>
      <Button
        ref={backRef}
        variant="text"
        color="inherit"
        size="small"
        aria-label={t('tickets:narrow.back', { view: viewName })}
        startIcon={<ChevronLeft size={16} aria-hidden="true" className="mirror-in-rtl" />}
        onClick={onBack}
        sx={{ minWidth: 0, maxWidth: '60%', justifyContent: 'flex-start' }}
      >
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {viewName}
        </Box>
      </Button>
      <Button
        variant="outlined"
        size="small"
        sx={{ marginInlineStart: 'auto', flexShrink: 0 }}
        startIcon={<PanelRightOpen size={16} aria-hidden="true" className="mirror-in-rtl" />}
        onClick={onDetails}
      >
        {t('tickets:header.details')}
      </Button>
    </Box>
  );
}
