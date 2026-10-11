import { META_PLATFORMS, type MetaPlatform, type MetaTestResult } from '@helpdock/schemas';
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
  Radio,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, PlugZap, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../../auth/session.tsx';
import { isMetaError, metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { looksLikeId, looksLikeToken } from './account-draft.js';
import { CodeText } from './code-text.tsx';
import { PLATFORM_ICONS } from './platforms.js';
import {
  problemFromError,
  problemFromResult,
  type TestProblem,
  TokenWorks,
} from './token-test.tsx';

/**
 * "Connect a Meta account" (M10-07, `Admin/Channels-Meta` panel 2): the
 * platform, the id Meta issued, the token and the department. **Connect stays
 * off until Test has succeeded for the id and token as typed**, so the account
 * is named after what Meta says it is; a refusal is said in Meta's words under
 * the field it concerns. Changing the platform clears the id and the token,
 * because they belong to it, and renames the id field.
 */
export function ConnectAccountDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const groupId = useId();
  const idId = useId();
  const tokenId = useId();
  const departmentId = useId();

  const [platform, setPlatform] = useState<MetaPlatform>('whatsapp');
  const [externalId, setExternalId] = useState('');
  const [token, setToken] = useState('');
  const [department, setDepartment] = useState('');
  const [tested, setTested] = useState<MetaTestResult | null>(null);
  const [problem, setProblem] = useState<TestProblem | null>(null);

  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
    enabled: open,
  });
  const first = departments.data?.departments[0]?.id ?? '';

  useEffect(() => {
    if (open) {
      setPlatform('whatsapp');
      setExternalId('');
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

  const forget = (): void => {
    setTested(null);
    setProblem(null);
  };

  const test = useMutation({
    mutationFn: async () => {
      if (!looksLikeId(externalId)) {
        setProblem({ field: 'id', message: t('channels:meta.connect.malformedId') });
        return null;
      }
      if (!looksLikeToken(token)) {
        setProblem({
          field: 'token',
          message: t('channels:meta.connect.malformedToken', { min: 16 }),
        });
        return null;
      }
      return api.testToken(brand.id, {
        platform,
        externalId: externalId.trim(),
        accessToken: token.trim(),
      });
    },
    onMutate: forget,
    onSuccess: (result) => {
      if (result === null) {
        return;
      }
      setTested(result);
      if (!result.ok) {
        setProblem(problemFromResult(result, t));
      }
    },
    onError: (error: unknown) => {
      setProblem(problemFromError(error, t));
    },
  });

  const connect = useMutation({
    mutationFn: () =>
      api.createAccount(brand.id, {
        platform,
        externalId: externalId.trim(),
        accessToken: token.trim(),
        departmentId: department,
        humanAgentEnabled: false,
      }),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: metaKeys.accounts(brand.id) });
      toast({
        tone: 'success',
        message: t('channels:meta.toast.connected', { name: account.displayName }),
      });
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(
        isMetaError(error)
          ? problemFromError(error, t)
          : { field: 'form', message: t('channels:toast.failed') },
      );
    },
  });

  const works = tested?.ok === true ? tested : null;
  const busy = test.isPending || connect.isPending;
  const departmentLabel = (id: string): string => {
    const found = departments.data?.departments.find((candidate) => candidate.id === id);
    return (locale === 'ar' ? found?.nameAr : null) ?? found?.name ?? '';
  };
  const idError = problem?.field === 'id' ? problem.message : undefined;
  const tokenError = problem?.field === 'token' ? problem.message : undefined;
  const formError = problem?.field === 'form' ? problem.message : undefined;
  const idHint = t(`channels:meta.connect.idHint.${platform}`);
  const tokenHint = <CodeText text={t(`channels:meta.connect.tokenHint.${platform}`)} />;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
      maxWidth="md"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 720, borderRadius: '10px' } } }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (works !== null) {
            connect.mutate();
          }
        }}
      >
        <DialogTitle
          sx={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2 }}
        >
          {t('channels:meta.connect.title')}
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
            {t('channels:meta.connect.intro')}
          </Typography>

          <Box component="fieldset" sx={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
            <Typography
              component="legend"
              sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', marginBlockEnd: '6px' }}
            >
              {t('channels:meta.connect.platform')}
            </Typography>
            <Box
              role="radiogroup"
              aria-label={t('channels:meta.connect.platform')}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(3, minmax(0, 1fr))' },
                gap: 3,
              }}
            >
              {META_PLATFORMS.map((option) => {
                const checked = platform === option;
                const inputId = `${groupId}-${option}`;
                const Icon = PLATFORM_ICONS[option];
                return (
                  <Box
                    key={option}
                    component="label"
                    htmlFor={inputId}
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 2,
                      padding: 3,
                      borderRadius: '6px',
                      border: `1px solid ${checked ? tokens['action.primary'] : tokens['border.strong']}`,
                      backgroundColor: checked
                        ? tokens['action.primary.tint']
                        : tokens['bg.surface'],
                      cursor: 'pointer',
                    }}
                  >
                    <Radio
                      id={inputId}
                      size="small"
                      checked={checked}
                      name={`${groupId}-platform`}
                      value={option}
                      disabled={busy}
                      onChange={() => {
                        setPlatform(option);
                        setExternalId('');
                        setToken('');
                        forget();
                      }}
                      sx={{ padding: 0, marginBlockStart: '2px' }}
                      slotProps={{ input: { 'aria-describedby': `${inputId}-hint` } }}
                    />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, fontWeight: 500 }}>
                        <Icon size={16} aria-hidden="true" />
                        {t(`channels:meta.platforms.${option}`)}
                      </Box>
                      <Typography
                        id={`${inputId}-hint`}
                        variant="caption"
                        sx={{ fontSize: 12, lineHeight: '16px', color: 'text.secondary' }}
                      >
                        {t(`channels:meta.connect.platformHint.${option}`)}
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
              gap: '16px 20px',
              alignItems: 'start',
            }}
          >
            <Field
              id={idId}
              label={t(`channels:meta.connect.id.${platform}`)}
              action={
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('channels:meta.connect.required')}
                </Typography>
              }
              hint={idHint}
              error={idError}
            >
              <TextField
                id={idId}
                size="small"
                autoComplete="off"
                required
                value={externalId}
                error={idError !== undefined}
                fullWidth
                onChange={(event) => {
                  setExternalId(event.target.value);
                  forget();
                }}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    inputMode: 'numeric',
                    spellCheck: false,
                    'aria-describedby': fieldDescribedBy(idId, { hint: idHint, error: idError }),
                    'aria-invalid': idError !== undefined,
                  },
                }}
                sx={{ '& input': (theme) => ({ ...theme.typography.mono, fontSize: 13 }) }}
              />
            </Field>

            <Field
              id={departmentId}
              label={t('channels:meta.connect.department')}
              hint={t('channels:meta.connect.departmentHint')}
            >
              <Select
                id={departmentId}
                size="small"
                value={department}
                fullWidth
                onChange={(event) => {
                  setDepartment(String(event.target.value));
                }}
                inputProps={{ 'aria-label': t('channels:meta.connect.department') }}
              >
                {(departments.data?.departments ?? []).map((option) => (
                  <MenuItem key={option.id} value={option.id}>
                    {departmentLabel(option.id)}
                  </MenuItem>
                ))}
              </Select>
            </Field>
          </Box>

          <Field
            id={tokenId}
            label={t('channels:meta.connect.token')}
            action={
              <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                {t('channels:meta.connect.required')}
              </Typography>
            }
            hint={tokenHint}
            error={tokenError}
          >
            <TextField
              id={tokenId}
              size="small"
              type="password"
              autoComplete="off"
              required
              value={token}
              error={tokenError !== undefined}
              fullWidth
              onChange={(event) => {
                setToken(event.target.value);
                forget();
              }}
              slotProps={{
                htmlInput: {
                  dir: 'ltr',
                  spellCheck: false,
                  'aria-describedby': fieldDescribedBy(tokenId, {
                    hint: tokenHint,
                    error: tokenError,
                  }),
                  'aria-invalid': tokenError !== undefined,
                },
              }}
              sx={{ '& input': (theme) => ({ ...theme.typography.mono, fontSize: 13 }) }}
            />
          </Field>

          {works === null ? null : <TokenWorks result={works} />}

          {formError === undefined ? null : (
            <Typography
              variant="caption"
              role="alert"
              sx={{ color: tokens['status.danger.text'], fontSize: 13 }}
            >
              {formError}
            </Typography>
          )}

          {platform === 'whatsapp' ? null : (
            <Box
              role="note"
              sx={{
                display: 'flex',
                gap: 2,
                alignItems: 'flex-start',
                padding: 3,
                borderRadius: '6px',
                backgroundColor: tokens['status.info.tint'],
                border: `1px solid ${tokens['status.info']}`,
                color: tokens['status.info.text'],
                fontSize: 13,
                lineHeight: '18px',
              }}
            >
              <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 1 }} />
              <Typography variant="body2" sx={{ color: 'inherit', fontSize: 13 }}>
                <strong>{t('channels:meta.connect.appReview.lead')}</strong>{' '}
                <CodeText text={t(`channels:meta.connect.appReview.${platform}`)} />
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ paddingBlock: 4, paddingInline: 6, gap: 2 }}>
          <Button
            variant="outlined"
            disabled={busy || externalId.trim() === '' || token.trim() === ''}
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
            {t('channels:meta.connect.test')}
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
            {t('channels:meta.connect.submit')}
          </Button>
        </DialogActions>
        <Typography
          id={`${tokenId}-test-first`}
          variant="caption"
          component="p"
          sx={{ color: 'text.secondary', paddingInline: 6, paddingBlockEnd: 5 }}
        >
          {works === null
            ? t('channels:meta.connect.testFirst')
            : t('channels:meta.connect.footnote')}
        </Typography>
      </Box>
    </Dialog>
  );
}
