import { Box, IconButton, OutlinedInput } from '@mui/material';
import { Copy } from 'lucide-react';
import { useT } from '../../../app/i18n.js';
import { Field } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';

export function SsoPublicValue({ id, label, value }: { id: string; label: string; value: string }) {
  const t = useT();
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ tone: 'success', message: t('sso:copied') });
    } catch {
      toast({ tone: 'danger', message: t('sso:copyError') });
    }
  };
  return (
    <Field id={id} label={label}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
        <OutlinedInput
          id={id}
          value={value}
          readOnly
          multiline
          fullWidth
          slotProps={{ input: { dir: 'ltr' } }}
        />
        <IconButton
          aria-label={t('sso:copy', { label })}
          onClick={() => {
            void copy();
          }}
        >
          <Copy size={16} aria-hidden="true" />
        </IconButton>
      </Box>
    </Field>
  );
}
