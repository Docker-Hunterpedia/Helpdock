import { META_TOKEN_MIN_LENGTH, type MetaAccount } from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlugZap, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { looksLikeToken } from './account-draft.js';
import { accountLabel } from './platforms.js';
import { problemFromError, TokenWorks, useTokenTest } from './token-test.tsx';

/**
 * "Reconnect @account" (M10-07, `Admin/Channels-Meta-Account` panel 3): a new
 * token for an account whose old one Meta invalidated. The account keeps its
 * tickets, contacts and settings, so the token is the only field, and
 * **Reconnect stays off until Test has succeeded** for it. Saving it is the
 * ordinary replace-the-token update, which answers `token-other-account` for a
 * token that belongs to a different account.
 */
export function ReconnectDialog({
  account,
  open,
  onClose,
}: {
  readonly account: MetaAccount;
  readonly open: boolean;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tokenId = useId();
  const [token, setToken] = useState('');
  const name = accountLabel(account);
  // The account's own id is taken by definition: naming the account tells the api this is a
  // replacement for it, which the id is free for, and for it alone.
  const test = useTokenTest({
    validate: () =>
      looksLikeToken(token)
        ? null
        : {
            field: 'token',
            message: t('channels:meta.connect.malformedToken', { min: META_TOKEN_MIN_LENGTH }),
          },
    request: () => ({
      platform: account.platform,
      externalId: account.externalId,
      accountId: account.id,
      accessToken: token.trim(),
    }),
  });
  const { tested, problem, setProblem, forget } = test;

  useEffect(() => {
    if (open) {
      setToken('');
      forget();
    }
  }, [open, forget]);

  const reconnect = useMutation({
    mutationFn: () =>
      api.updateAccount(brand.id, account.id, {
        displayName: account.displayName,
        departmentId: account.departmentId,
        humanAgentEnabled: account.humanAgentEnabled,
        accessToken: token.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: metaKeys.accounts(brand.id) });
      await queryClient.invalidateQueries({ queryKey: metaKeys.account(brand.id, account.id) });
      await queryClient.invalidateQueries({ queryKey: metaKeys.status(brand.id, account.id) });
      toast({ tone: 'success', message: t('channels:meta.toast.reconnected', { name }) });
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(problemFromError(error, t));
    },
  });

  const works = tested?.ok === true ? tested : null;
  const busy = test.pending || reconnect.isPending;
  const hint = t(`channels:meta.reconnect.tokenHint.${account.platform}`);
  const error = problem?.message;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 440, borderRadius: '10px' } } }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (works !== null) {
            reconnect.mutate();
          }
        }}
      >
        <DialogTitle sx={{ typography: 'h3', display: 'flex', alignItems: 'center', gap: 2 }}>
          {t('channels:meta.reconnect.title', { name })}
          <IconButton
            size="small"
            aria-label={t('common:actions.close')}
            disabled={busy}
            onClick={onClose}
            sx={{ marginInlineStart: 'auto' }}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t(`channels:meta.reconnect.intro.${account.platform}`)}
          </Typography>

          <Field
            id={tokenId}
            label={t('channels:meta.connect.token')}
            action={
              <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                {t('channels:meta.connect.required')}
              </Typography>
            }
            hint={hint}
            error={error}
          >
            <TextField
              id={tokenId}
              size="small"
              type="password"
              autoComplete="off"
              required
              value={token}
              error={error !== undefined}
              fullWidth
              onChange={(event) => {
                setToken(event.target.value);
                forget();
              }}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  spellCheck: false,
                  'aria-describedby': fieldDescribedBy(tokenId, { hint, error }),
                  'aria-invalid': error !== undefined,
                },
              }}
              sx={{ '& input': (theme) => theme.typography.mono }}
            />
          </Field>

          {works === null ? null : <TokenWorks result={works} />}
        </DialogContent>
        <DialogActions sx={{ paddingBlock: 4, paddingInline: 6, gap: 2 }}>
          <Button
            variant="outlined"
            disabled={busy || token.trim() === ''}
            aria-busy={test.pending}
            startIcon={
              test.pending ? (
                <CircularProgress size={14} aria-hidden="true" />
              ) : (
                <PlugZap size={16} aria-hidden="true" />
              )
            }
            onClick={test.run}
            sx={{ marginInlineEnd: 'auto' }}
          >
            {t('channels:meta.connect.test')}
          </Button>
          <Button variant="text" disabled={busy} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || works === null}>
            {t('channels:meta.reconnect.submit')}
          </Button>
        </DialogActions>
        <Typography
          variant="caption"
          component="p"
          sx={{ color: tokens['text.secondary'], paddingInline: 6, paddingBlockEnd: 5 }}
        >
          {t(
            account.platform === 'instagram'
              ? 'channels:meta.reconnect.footnoteInstagram'
              : 'channels:meta.reconnect.footnote',
          )}
        </Typography>
      </Box>
    </Dialog>
  );
}
