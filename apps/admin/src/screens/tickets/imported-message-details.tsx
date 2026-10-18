import type { TicketMessage } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { useT } from '../../app/i18n.js';

/** Source facts are a disclosure, never delivery-state controls. */
export function ImportedMessageDetails({ details }: { details: TicketMessage['importDetails'] }) {
  const t = useT();
  if (!details || !Object.values(details).some((value) => value !== undefined)) return null;
  return (
    <Box component="details" sx={{ marginBlockStart: 2 }}>
      <Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>
        {t('tickets:importedMessage.title')}
      </Typography>
      <Box component="dl" sx={{ margin: 0, display: 'grid', gap: 1 }}>
        {(
          [
            'status',
            'channel',
            'direction',
            'authorKind',
            'authorType',
            'via',
            'mailSubject',
            'mailDate',
            'mailReturnPath',
          ] as const
        ).map((field) =>
          details[field] === undefined ? null : (
            <Box key={field}>
              <Typography component="dt" variant="caption" color="text.secondary">
                {t(`tickets:importedMessage.${field}`)}
              </Typography>
              <Typography
                component="dd"
                variant="body2"
                sx={{ margin: 0, overflowWrap: 'anywhere' }}
              >
                <bdi>
                  {field === 'authorKind' && details.authorKind
                    ? t(`tickets:importedMessage.kinds.${details.authorKind}`)
                    : details[field]}
                </bdi>
              </Typography>
            </Box>
          ),
        )}
      </Box>
    </Box>
  );
}
