import {
  Box,
  Button,
  Chip,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSsoApi } from '../../../sso/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { latinNumbering } from '../../../ui/format.js';

/** The SAML variant's public certificate table; PEM inspection happens at the API boundary. */
export function SsoCertificates({
  certificates,
  onChange,
}: {
  certificates: string[];
  onChange: (certificates: string[]) => void;
}) {
  const t = useT();
  const { locale } = usePreferences();
  const api = useSsoApi();
  const [adding, setAdding] = useState(false);
  const [pem, setPem] = useState('');
  const summaries = useQuery({
    queryKey: ['sso', 'certificates', certificates],
    queryFn: () => api.inspectCertificates(certificates),
    enabled: certificates.length > 0,
    retry: false,
  });
  const inspect = useMutation({
    mutationFn: () => api.inspectCertificates([pem.trim()]),
    onSuccess: () => {
      if (!certificates.includes(pem.trim())) onChange([...certificates, pem.trim()]);
      setPem('');
      setAdding(false);
    },
  });
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography variant="bodyStrong">{t('sso:certificates')}</Typography>
      {summaries.isError ? (
        <AlertBanner tone="danger">{t('sso:invalidCertificate')}</AlertBanner>
      ) : null}
      <TableContainer>
        <Table aria-label={t('sso:certificates')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('sso:certificateSubject')}</TableCell>
              <TableCell>{t('sso:certificateFingerprint')}</TableCell>
              <TableCell>{t('sso:certificateExpires')}</TableCell>
              <TableCell>{t('sso:mappingActions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {certificates.map((certificate, index) => {
              const summary = summaries.data?.certificates[index];
              const expiry = summary ? Date.parse(summary.expiresAt) : null;
              return (
                <TableRow key={certificate}>
                  <TableCell>{summary?.subject ?? t('common:loading')}</TableCell>
                  <TableCell sx={{ overflowWrap: 'anywhere' }}>
                    <bdi dir="ltr">{summary?.fingerprint}</bdi>
                  </TableCell>
                  <TableCell>
                    {expiry === null
                      ? ''
                      : new Intl.DateTimeFormat(latinNumbering(locale), {
                          dateStyle: 'medium',
                        }).format(expiry)}
                    {expiry !== null && expiry - Date.now() < 30 * 86400000 ? (
                      <Chip
                        size="small"
                        color="warning"
                        label={t(
                          expiry <= Date.now() ? 'sso:certificateExpired' : 'sso:certificateSoon',
                        )}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <IconButton
                      aria-label={t('sso:removeCertificate')}
                      onClick={() =>
                        onChange(certificates.filter((_pem, position) => position !== index))
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Button
        disabled={certificates.length >= 3}
        startIcon={<Plus size={16} aria-hidden="true" />}
        onClick={() => {
          inspect.reset();
          setAdding(true);
        }}
      >
        {t('sso:addCertificate')}
      </Button>
      <ConfirmDialog
        open={adding}
        title={t('sso:addCertificate')}
        body={t('sso:certificateHint')}
        confirmLabel={t('sso:addCertificate')}
        confirmDisabled={!pem.trim()}
        busy={inspect.isPending}
        onConfirm={() => inspect.mutate()}
        onClose={() => {
          setAdding(false);
          setPem('');
        }}
      >
        <TextField
          label={t('sso:certificatePem')}
          multiline
          minRows={4}
          value={pem}
          onChange={(event) => setPem(event.target.value)}
          slotProps={{ htmlInput: { dir: 'ltr', maxLength: 16000 } }}
        />
        {inspect.isError ? (
          <AlertBanner tone="danger">{t('sso:invalidCertificate')}</AlertBanner>
        ) : null}
      </ConfirmDialog>
    </Box>
  );
}
