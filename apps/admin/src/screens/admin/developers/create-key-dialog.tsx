import {
  API_KEY_RATE_LIMIT_DEFAULT,
  API_KEY_RATE_LIMIT_MAX,
  API_SCOPES,
  type ApiKeyCreated,
  type ApiScope,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { CheckList } from './check-list.tsx';

/**
 * "Create API key" (`Admin/Developers-ApiKeys` panel 1): a name, the scopes,
 * and a rate limit that defaults to the api's. The key itself comes back in
 * the answer and goes straight to SecretReveal; this dialog never holds it.
 */

interface Problems {
  readonly name?: string;
  readonly scopes?: string;
  readonly rateLimit?: string;
}

export function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  onClose(): void;
  onCreated(key: ApiKeyCreated): void;
}): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const nameId = useId();
  const rateId = useId();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<readonly ApiScope[]>([]);
  const [rateLimit, setRateLimit] = useState(String(API_KEY_RATE_LIMIT_DEFAULT));
  const [problems, setProblems] = useState<Problems>({});

  const reset = (): void => {
    setName('');
    setScopes([]);
    setRateLimit(String(API_KEY_RATE_LIMIT_DEFAULT));
    setProblems({});
  };

  const create = useMutation({
    mutationFn: () =>
      api.createApiKey(brand.id, {
        name: name.trim(),
        scopes: [...scopes],
        rateLimitPerMinute: Number(rateLimit),
      }),
    onSuccess: (key) => {
      reset();
      onCreated(key);
    },
    onError: () => {
      toast({ tone: 'danger', message: t('developers:failed') });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const limit = Number(rateLimit);
    const found: Problems = {
      ...(name.trim() === '' ? { name: t('developers:keys.dialog.nameRequired') } : {}),
      ...(scopes.length === 0 ? { scopes: t('developers:keys.dialog.scopesRequired') } : {}),
      ...(Number.isInteger(limit) && limit >= 1 && limit <= API_KEY_RATE_LIMIT_MAX
        ? {}
        : {
            rateLimit: t('developers:keys.dialog.rateLimitInvalid', {
              max: API_KEY_RATE_LIMIT_MAX,
            }),
          }),
    };
    setProblems(found);
    if (Object.keys(found).length === 0) {
      create.mutate();
    }
  };

  const close = (): void => {
    if (!create.isPending) {
      reset();
      onClose();
    }
  };

  const nameHint = t('developers:keys.dialog.nameHint');
  const rateHint = t('developers:keys.dialog.rateLimitHint', {
    default: API_KEY_RATE_LIMIT_DEFAULT,
  });

  return (
    <Dialog
      open={open}
      onClose={close}
      aria-labelledby={titleId}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle
          id={titleId}
          sx={{
            fontSize: 16,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {t('developers:keys.dialog.title')}
          <IconButton size="small" aria-label={t('developers:keys.dialog.close')} onClick={close}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Field
            id={nameId}
            label={t('developers:keys.dialog.name')}
            hint={nameHint}
            error={problems.name}
          >
            <TextField
              id={nameId}
              size="small"
              value={name}
              error={problems.name !== undefined}
              onChange={(event) => {
                setName(event.target.value);
              }}
              slotProps={{
                htmlInput: {
                  maxLength: 100,
                  'aria-invalid': problems.name !== undefined,
                  'aria-describedby': fieldDescribedBy(nameId, {
                    hint: nameHint,
                    error: problems.name,
                  }),
                },
              }}
            />
          </Field>

          <CheckList
            legend={t('developers:keys.dialog.scopes')}
            options={API_SCOPES.map((scope) => ({
              value: scope,
              hint: t(`developers:keys.scopeHints.${scope}`),
            }))}
            selected={scopes}
            error={problems.scopes}
            onChange={setScopes}
          />

          <Field
            id={rateId}
            label={t('developers:keys.dialog.rateLimit')}
            hint={rateHint}
            error={problems.rateLimit}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <TextField
                id={rateId}
                size="small"
                value={rateLimit}
                error={problems.rateLimit !== undefined}
                onChange={(event) => {
                  setRateLimit(event.target.value);
                }}
                slotProps={{
                  htmlInput: {
                    inputMode: 'numeric',
                    dir: 'ltr',
                    'aria-invalid': problems.rateLimit !== undefined,
                    'aria-describedby': fieldDescribedBy(rateId, {
                      hint: rateHint,
                      error: problems.rateLimit,
                    }),
                    style: { fontFamily: 'var(--hd-font-mono, monospace)' },
                  },
                }}
                sx={{ width: 120 }}
              />
              <Typography variant="body2" sx={{ color: tokens['text.secondary'] }}>
                {t('developers:keys.dialog.rateLimitUnit')}
              </Typography>
            </Box>
          </Field>
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={close} disabled={create.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={create.isPending}>
            {t('developers:keys.dialog.submit')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
