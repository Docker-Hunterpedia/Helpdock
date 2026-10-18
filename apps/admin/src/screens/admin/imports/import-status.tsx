import type { ImportRunView } from '@helpdock/schemas';
import { Box } from '@mui/material';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/** Existing DESIGN StatusBadge anatomy, with the import phase expressed in text. */
export function ImportStatus({ status }: { status: ImportRunView['status'] }) {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone =
    status === 'completed'
      ? 'success'
      : status === 'failed'
        ? 'danger'
        : status === 'paused' || status === 'awaiting_mapping'
          ? 'warning'
          : 'info';
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        blockSize: 22,
        paddingInline: 2,
        borderRadius: '999px',
        whiteSpace: 'nowrap',
        backgroundColor: tokens[`status.${tone}.tint`],
        color: tokens[`status.${tone}.text`],
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          inlineSize: 6,
          blockSize: 6,
          borderRadius: '999px',
          backgroundColor: tokens[`status.${tone}`],
        }}
      />
      {t(`imports:status.${status}`)}
    </Box>
  );
}
