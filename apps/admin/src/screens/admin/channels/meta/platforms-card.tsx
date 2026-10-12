import { META_PLATFORMS } from '@helpdock/schemas';
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { PLATFORM_ICONS } from './platforms.js';

/**
 * "What each platform asks for" (M10-07, `Admin/Channels-Meta` panel 2): the
 * id field, the kind of token and how long it lasts, beside the empty state,
 * where a person with no account yet needs to know what to bring.
 */
export function PlatformsCard(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      <Typography
        id={headingId}
        variant="h3"
        component="h2"
        sx={{ paddingBlock: 3, paddingInline: 4 }}
      >
        {t('channels:meta.guide.heading')}
      </Typography>
      <TableContainer>
        <Table aria-labelledby={headingId}>
          <TableHead>
            <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableCell>{t('channels:meta.guide.columns.platform')}</TableCell>
              <TableCell>{t('channels:meta.guide.columns.id')}</TableCell>
              <TableCell>{t('channels:meta.guide.columns.token')}</TableCell>
              <TableCell>{t('channels:meta.guide.columns.lasts')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {META_PLATFORMS.map((platform) => {
              const Icon = PLATFORM_ICONS[platform];
              return (
                <TableRow key={platform}>
                  <TableCell>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <Icon size={16} aria-hidden="true" />
                      {t(`channels:meta.platforms.${platform}`)}
                    </Box>
                  </TableCell>
                  <TableCell>{t(`channels:meta.guide.id.${platform}`)}</TableCell>
                  <TableCell>{t(`channels:meta.guide.token.${platform}`)}</TableCell>
                  <TableCell>{t(`channels:meta.guide.lasts.${platform}`)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
