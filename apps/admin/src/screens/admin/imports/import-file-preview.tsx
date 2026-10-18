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
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import type { ImportFileView } from '../../../imports/api.js';
import { occurrenceKeys } from '../../../imports/occurrence-keys.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';

export function ImportFilePreview({ file, stale }: { file: ImportFileView; stale: boolean }) {
  const t = useT();
  const { locale } = usePreferences();
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  if (stale) return <AlertBanner tone="info">{t('imports:columns.previewStale')}</AlertBanner>;
  if (!file.validation)
    return file.mapping ? (
      <Typography role="status">{t('imports:columns.validating')}</Typography>
    ) : null;
  const { validation } = file;
  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      <Typography component="h3" variant="h3">
        {t('imports:columns.preview')}
      </Typography>
      <Typography variant="caption">
        {t('imports:columns.previewCaption', {
          checked: number.format(validation.checkedRows),
          shown: number.format(validation.preview.rows.length),
          invalid: number.format(validation.invalidRows),
        })}
      </Typography>
      {validation.invalidRows > 0 ? (
        <AlertBanner tone="warning">
          {t(
            file.mapping?.skipInvalidRows
              ? 'imports:columns.skippedRows'
              : 'imports:columns.invalidRows',
          )}
        </AlertBanner>
      ) : null}
      <TableContainer>
        <Table size="small" aria-label={t('imports:columns.preview')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('imports:columns.row')}</TableCell>
              <TableCell>{t('imports:columns.record')}</TableCell>
              <TableCell>{t('imports:columns.result')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {validation.preview.rows.map(({ line, result }) => (
              <TableRow key={line}>
                <TableCell>
                  <bdi dir="ltr">{number.format(line)}</bdi>
                </TableCell>
                <TableCell sx={{ overflowWrap: 'anywhere' }}>
                  {result.ok ? (
                    result.records.map((record) => (
                      <Box key={`${record.entity}:${record.payload.externalId}`}>
                        <Typography>
                          {t(`imports:entities.${record.entity}`)} ·{' '}
                          <bdi>{record.payload.externalId}</bdi>
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          <bdi>
                            {'subject' in record.payload
                              ? record.payload.subject
                              : 'name' in record.payload
                                ? record.payload.name
                                : 'title' in record.payload
                                  ? record.payload.title
                                  : 'bodyText' in record.payload
                                    ? record.payload.bodyText
                                    : ''}
                          </bdi>
                        </Typography>
                        {'createdAt' in record.payload && record.payload.createdAt ? (
                          <Typography variant="caption" component="div">
                            <bdi dir="ltr">{record.payload.createdAt}</bdi>
                          </Typography>
                        ) : null}
                      </Box>
                    ))
                  ) : (
                    <Typography>{t('imports:columns.invalidRecord')}</Typography>
                  )}
                </TableCell>
                <TableCell>
                  {result.ok ? (
                    t('imports:columns.valid')
                  ) : (
                    <Box component="ul" sx={{ margin: 0, paddingInlineStart: 4 }}>
                      {occurrenceKeys(result.issues, (issue) => JSON.stringify(issue)).map(
                        ({ entry: issue, key }) => (
                          <li key={key}>
                            <Typography variant="caption">
                              {t(`imports:columns.errors.${issue.code}`)} <bdi>{issue.target}</bdi>
                            </Typography>
                          </li>
                        ),
                      )}
                    </Box>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
