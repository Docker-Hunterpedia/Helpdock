import type { AiModelList } from '@helpdock/schemas';
import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { usd } from '../format.js';

const FIRST = 5;

/**
 * What "Discover models" found: id, context window and price per million
 * tokens in and out, from pi-ai's registry (or the server's own list for an
 * OpenAI-compatible one). The first five, then "Show all".
 */
export function ModelsTable({
  name,
  models,
}: {
  readonly name: string;
  readonly models: AiModelList['models'];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [all, setAll] = useState(false);
  const shown = all ? models : models.slice(0, FIRST);

  return (
    <Box
      sx={{
        border: `1px solid ${tokens['border.default']}`,
        borderRadius: '6px',
        overflowX: 'auto',
      }}
    >
      <Table size="small" aria-label={t('aiSettings:provider.modelsLabel', { name })}>
        <TableHead>
          <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
            <TableCell>{t('aiSettings:provider.modelColumns.model')}</TableCell>
            <TableCell sx={{ textAlign: 'end' }}>
              {t('aiSettings:provider.modelColumns.context')}
            </TableCell>
            <TableCell sx={{ textAlign: 'end' }}>
              {t('aiSettings:provider.modelColumns.price')}
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.map((model) => (
            <TableRow key={model.id}>
              <TableCell>
                <Typography variant="mono" component="span" dir="ltr" sx={{ fontSize: 13 }}>
                  {model.id}
                </Typography>
              </TableCell>
              <TableCell sx={{ textAlign: 'end' }}>
                <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
                  {model.contextWindow.toLocaleString('en-US')}
                </Typography>
              </TableCell>
              <TableCell sx={{ textAlign: 'end' }}>
                <Typography variant="mono" component="span" dir="ltr" sx={{ fontSize: 12 }}>
                  {usd(model.inputPerMillionUsd)} / {usd(model.outputPerMillionUsd)}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          paddingInline: 3,
          paddingBlock: 2,
          backgroundColor: tokens['bg.canvas'],
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:provider.modelsShowing', { shown: shown.length, total: models.length })}
        </Typography>
        {models.length > FIRST && !all ? (
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setAll(true);
            }}
          >
            {t('aiSettings:provider.showAll')}
          </Button>
        ) : null}
      </Box>
    </Box>
  );
}
