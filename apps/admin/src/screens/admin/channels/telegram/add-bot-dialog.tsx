import type { TelegramTestResult } from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, PlugZap, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../../auth/session.tsx';
import { isTelegramError, telegramKeys } from '../../../../telegram/api.js';
import { useTelegramApi } from '../../../../telegram/context.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { looksLikeToken } from './bot-draft.js';

/**
 * "Add a Telegram bot" (M6-05, `Admin/Channels-Telegram` panel 3): the token
 * and the department. **Add bot stays off until Test has succeeded for the
 * token as typed**, so the bot is named after what Telegram says it is; a
 * refused token is said in Telegram's words under the field. In production the
 * webhook is set straight after the bot is added.
 */
export function AddBotDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useTelegramApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const tokenId = useId();
  const departmentId = useId();

  const [token, setToken] = useState('');
  const [department, setDepartment] = useState('');
  const [tested, setTested] = useState<TelegramTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
    enabled: open,
  });
  const first = departments.data?.departments[0]?.id ?? '';

  useEffect(() => {
    if (open) {
      setToken('');
      setTested(null);
      setProblem(null);
    }
  }, [open]);

  useEffect(() => {
    if (department === '' && first !== '') {
      setDepartment(first);
    }
  }, [department, first]);

  const test = useMutation({
    mutationFn: async () => {
      if (!looksLikeToken(token)) {
        setProblem(t('channels:telegram.add.malformed'));
        return null;
      }
      return api.testToken(brand.id, token.trim());
    },
    onMutate: () => {
      setTested(null);
      setProblem(null);
    },
    onSuccess: (result) => {
      if (result === null) {
        return;
      }
      setTested(result);
      if (!result.ok) {
        setProblem(
          result.kind === 'connect'
            ? t('channels:telegram.add.unreachable')
            : t('channels:telegram.add.refused', { detail: result.detail ?? '401' }),
        );
      }
    },
    onError: () => {
      setProblem(t('channels:telegram.add.unreachable'));
    },
  });

  const add = useMutation({
    mutationFn: async (name: string) => {
      const bot = await api.createBot(brand.id, {
        displayName: name,
        departmentId: department,
        token: token.trim(),
        welcomeEn: null,
        welcomeAr: null,
        languagePick: true,
      });
      if (bot.mode === 'webhook') {
        // The bot exists either way; a refused webhook shows on its page.
        await api.setWebhook(brand.id, bot.id).catch(() => undefined);
      }
      return bot;
    },
    onSuccess: async (bot) => {
      await queryClient.invalidateQueries({ queryKey: telegramKeys.bots(brand.id) });
      toast({
        tone: 'success',
        message: t('channels:telegram.toast.created', { username: bot.username }),
      });
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(
        isTelegramError(error)
          ? t(`channels:telegram.refusal.${error.reason}`)
          : t('channels:toast.failed'),
      );
    },
  });

  const works = tested?.ok === true ? tested : null;
  const busy = test.isPending || add.isPending;
  const departmentLabel = (id: string): string => {
    const found = departments.data?.departments.find((candidate) => candidate.id === id);
    return (locale === 'ar' ? found?.nameAr : null) ?? found?.name ?? '';
  };
  const hint = t('channels:telegram.add.tokenHint');

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
      slotProps={{ paper: { sx: { maxWidth: 400, borderRadius: '10px' } } }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (works !== null) {
            add.mutate(works.name);
          }
        }}
      >
        <DialogTitle
          sx={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2 }}
        >
          {t('channels:telegram.add.title')}
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
            {t('channels:telegram.add.intro')}
          </Typography>

          <Field
            id={tokenId}
            label={t('channels:telegram.add.token')}
            action={
              <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                {t('channels:telegram.add.required')}
              </Typography>
            }
            hint={hint}
            error={problem ?? undefined}
          >
            <TextField
              id={tokenId}
              size="small"
              type="password"
              autoComplete="off"
              required
              value={token}
              error={problem !== null}
              fullWidth
              onChange={(event) => {
                setToken(event.target.value);
                setTested(null);
                setProblem(null);
              }}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  spellCheck: false,
                  'aria-describedby': fieldDescribedBy(tokenId, {
                    hint,
                    error: problem ?? undefined,
                  }),
                  'aria-invalid': problem !== null,
                },
              }}
            />
          </Field>

          <Field id={departmentId} label={t('channels:telegram.add.department')}>
            <Select
              id={departmentId}
              size="small"
              value={department}
              fullWidth
              onChange={(event) => {
                setDepartment(String(event.target.value));
              }}
              inputProps={{ 'aria-label': t('channels:telegram.add.department') }}
            >
              {(departments.data?.departments ?? []).map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {departmentLabel(option.id)}
                </MenuItem>
              ))}
            </Select>
          </Field>

          {works === null ? null : (
            <Box
              role="status"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                paddingBlock: 2,
                paddingInline: 3,
                borderRadius: '6px',
                border: `1px solid ${tokens['status.success']}`,
                backgroundColor: tokens['status.success.tint'],
                color: tokens['status.success.text'],
                fontSize: 13,
              }}
            >
              <CircleCheck size={16} aria-hidden="true" />
              <bdi>{t('channels:telegram.add.works', { username: works.username })}</bdi>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button
            variant="outlined"
            disabled={busy || token.trim() === ''}
            aria-busy={test.isPending}
            startIcon={
              test.isPending ? (
                <CircularProgress size={14} aria-hidden="true" />
              ) : (
                <PlugZap size={16} aria-hidden="true" />
              )
            }
            onClick={() => {
              test.mutate();
            }}
            sx={{ marginInlineEnd: 'auto' }}
          >
            {t('channels:telegram.add.test')}
          </Button>
          <Button variant="text" disabled={busy} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={busy || works === null || department === ''}
            aria-describedby={works === null ? `${tokenId}-test-first` : undefined}
          >
            {t('channels:telegram.add.submit')}
          </Button>
        </DialogActions>
        <Typography
          id={`${tokenId}-test-first`}
          variant="caption"
          component="p"
          sx={{ color: 'text.secondary', paddingInline: 6, paddingBlockEnd: 5 }}
        >
          {works === null ? `${t('channels:telegram.add.testFirst')} ` : null}
          {t('channels:telegram.add.footnote')}
        </Typography>
      </Box>
    </Dialog>
  );
}
