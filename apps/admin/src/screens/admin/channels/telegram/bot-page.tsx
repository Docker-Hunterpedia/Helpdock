import type { TelegramBot, TelegramBotStatus } from '@helpdock/schemas';
import {
  TELEGRAM_LANGUAGE_PROMPT_MAX_LENGTH,
  TELEGRAM_WELCOME_MAX_LENGTH,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Link as MuiLink,
  Select,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Send, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { channelsRoute, ROUTES } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../../auth/session.tsx';
import { EmptyState } from '../../../../shell/empty-state.tsx';
import { isTelegramError, telegramKeys } from '../../../../telegram/api.js';
import { useTelegramApi } from '../../../../telegram/context.tsx';
import { Field } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { ago, clockTime, shortDate } from '../format.js';
import {
  type BotDraft,
  type BotDraftErrors,
  draftFromBot,
  isDraftDirty,
  validateDraft,
} from './bot-draft.js';
import { BotHealth } from './bot-health.tsx';
import { ConnectionSection } from './connection-section.tsx';
import { DeleteBotDialog } from './delete-bot-dialog.tsx';
import { Card, FormSection } from './form-section.tsx';
import { WebhookSection } from './webhook-section.tsx';
import { WelcomeSection } from './welcome-section.tsx';

/**
 * One bot (M6-05, `Admin/Channels-Telegram` panel 2): its form — Connection,
 * Webhook, Routing, Welcome and language, saved together — beside the Activity
 * card and the Delete card.
 */
export function TelegramBotPage({ botId }: { readonly botId: string }): ReactNode {
  const t = useT();
  const api = useTelegramApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());

  const bot = useQuery({
    queryKey: telegramKeys.bot(brand.id, botId),
    queryFn: () => api.bot(brand.id, botId),
  });
  const status = useQuery({
    queryKey: telegramKeys.status(brand.id, botId),
    queryFn: () => api.status(brand.id, botId),
  });
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
  });

  if (bot.isError) {
    return (
      <EmptyState
        icon={Send}
        heading={t('channels:telegram.detail.notFound.heading')}
        body={t('channels:telegram.detail.notFound.body')}
        action={
          <Button variant="outlined" component={Link} to={channelsRoute('telegram')}>
            {t('channels:telegram.detail.back')}
          </Button>
        }
      />
    );
  }
  if (bot.data === undefined || departments.data === undefined) {
    return <CircularProgress aria-label={t('channels:telegram.heading')} />;
  }

  return (
    <BotForm
      key={bot.data.id}
      bot={bot.data}
      status={status.data}
      checkedAt={status.dataUpdatedAt}
      departments={departments.data.departments}
    />
  );
}

interface DepartmentOption {
  readonly id: string;
  readonly name: string;
  readonly nameAr: string | null;
}

function BotForm({
  bot,
  status,
  checkedAt,
  departments,
}: {
  readonly bot: TelegramBot;
  readonly status: TelegramBotStatus | undefined;
  readonly checkedAt: number;
  readonly departments: readonly DepartmentOption[];
}): ReactNode {
  const t = useT();
  const api = useTelegramApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const departmentId = useId();

  const saved = useMemo(() => draftFromBot(bot), [bot]);
  const [draft, setDraft] = useState<BotDraft>(saved);
  const [errors, setErrors] = useState<BotDraftErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [now] = useState(Date.now);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const change = <K extends keyof BotDraft>(key: K, value: BotDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setRefusal(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      const checked = validateDraft(draft, bot.displayName);
      if (!checked.ok) {
        setErrors(checked.errors);
        return undefined;
      }
      return api.updateBot(brand.id, bot.id, checked.request);
    },
    onSuccess: async (result) => {
      if (result === undefined) {
        return;
      }
      queryClient.setQueryData(telegramKeys.bot(brand.id, bot.id), result);
      await queryClient.invalidateQueries({ queryKey: telegramKeys.bots(brand.id) });
      toast({
        tone: 'success',
        message: t('channels:telegram.toast.saved', { username: result.username }),
      });
    },
    onError: (error: unknown) => {
      if (isTelegramError(error)) {
        setRefusal(t(`channels:telegram.refusal.${error.reason}`));
        return;
      }
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const dirty = isDraftDirty(draft, saved);
  const tooLong = (max: number): string => t('channels:telegram.detail.welcome.tooLong', { max });
  const departmentName = (id: string): string => {
    const found = departments.find((department) => department.id === id);
    return (locale === 'ar' ? found?.nameAr : null) ?? found?.name ?? '';
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 320px' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Card>
        <Box
          component="form"
          noValidate
          aria-label={`@${bot.username}`}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Box
            component="header"
            sx={{ padding: 5, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
          >
            <IconButton
              component={Link}
              to={channelsRoute('telegram')}
              aria-label={t('channels:telegram.detail.back')}
              size="small"
            >
              <ArrowLeft size={16} aria-hidden="true" className="mirror-in-rtl" />
            </IconButton>
            <Box
              aria-hidden="true"
              sx={{
                width: 36,
                height: 36,
                borderRadius: '6px',
                display: 'grid',
                placeItems: 'center',
                backgroundColor: tokens['bg.muted'],
              }}
            >
              <Send size={16} />
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Typography variant="h1" component="h2" sx={{ fontSize: 20 }}>
                <bdi>@{bot.username}</bdi>
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                <bdi>
                  {t('channels:telegram.detail.caption', {
                    name: bot.displayName,
                    date: shortDate(bot.createdAt, locale),
                  })}
                </bdi>
              </Typography>
            </Box>
            <Box sx={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
              <BotHealth bot={bot} />
              {bot.health.lastUpdateAt === null ? null : (
                <Typography
                  variant="mono"
                  component="span"
                  sx={{ fontSize: 12, color: 'text.secondary' }}
                >
                  {t('channels:telegram.detail.update', {
                    ago: ago(bot.health.lastUpdateAt, now, locale),
                  })}
                </Typography>
              )}
            </Box>
          </Box>

          <ConnectionSection
            bot={bot}
            token={draft.token}
            tokenError={
              errors.token === undefined ? undefined : t('channels:telegram.add.malformed')
            }
            onTokenChange={(token) => {
              change('token', token);
            }}
          />

          <WebhookSection bot={bot} status={status} checkedAt={checkedAt} />

          <FormSection
            heading={t('channels:telegram.detail.routing.heading')}
            caption={t('channels:telegram.detail.routing.caption')}
          >
            <Box sx={{ maxWidth: 320 }}>
              <Field
                id={departmentId}
                label={t('channels:telegram.detail.routing.department')}
                hint={t('channels:telegram.detail.routing.hint')}
              >
                <Select
                  id={departmentId}
                  size="small"
                  value={draft.departmentId}
                  fullWidth
                  onChange={(event) => {
                    change('departmentId', String(event.target.value));
                  }}
                  inputProps={{ 'aria-label': t('channels:telegram.detail.routing.department') }}
                >
                  {departments.map((department) => (
                    <MenuItem key={department.id} value={department.id}>
                      {departmentName(department.id)}
                    </MenuItem>
                  ))}
                </Select>
              </Field>
            </Box>
          </FormSection>

          <WelcomeSection
            draft={draft}
            errors={{
              languagePrompt:
                errors.languagePrompt === undefined
                  ? undefined
                  : tooLong(TELEGRAM_LANGUAGE_PROMPT_MAX_LENGTH),
              welcomeEn:
                errors.welcomeEn === undefined ? undefined : tooLong(TELEGRAM_WELCOME_MAX_LENGTH),
              welcomeAr:
                errors.welcomeAr === undefined ? undefined : tooLong(TELEGRAM_WELCOME_MAX_LENGTH),
            }}
            onChange={change}
          />

          <Box
            sx={{
              paddingBlock: 3,
              paddingInline: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              flexWrap: 'wrap',
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              borderEndStartRadius: '10px',
              borderEndEndRadius: '10px',
            }}
          >
            {refusal === null ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }} aria-live="polite">
                {dirty
                  ? t('channels:telegram.detail.footer.unsaved')
                  : t('channels:telegram.detail.footer.note')}
              </Typography>
            ) : (
              <Typography
                variant="caption"
                role="alert"
                sx={{ color: tokens['status.danger.text'] }}
              >
                {refusal}
              </Typography>
            )}
            <Button
              variant="text"
              sx={{ marginInlineStart: 'auto' }}
              disabled={!dirty}
              onClick={() => {
                setDraft(saved);
                setErrors({});
                setRefusal(null);
              }}
            >
              {t('channels:telegram.detail.footer.discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={!dirty || save.isPending}>
              {t('channels:telegram.detail.footer.save')}
            </Button>
          </Box>
        </Box>
      </Card>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ActivityCard bot={bot} status={status} />
        <Card label={t('channels:telegram.detail.danger.heading')} tone="danger">
          <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Typography
              variant="h3"
              component="h2"
              sx={{ fontSize: 16, color: tokens['status.danger.text'] }}
            >
              {t('channels:telegram.detail.danger.heading')}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('channels:telegram.detail.danger.body')}
            </Typography>
            <Button
              variant="outlined"
              color="error"
              aria-haspopup="dialog"
              startIcon={<Trash2 size={16} aria-hidden="true" />}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setDeleting(true);
              }}
            >
              {t('channels:telegram.detail.danger.action')}
            </Button>
          </Box>
        </Card>
      </Box>

      <DeleteBotDialog
        bot={deleting ? bot : null}
        onClose={() => {
          setDeleting(false);
        }}
        onDeleted={() => {
          void navigate(channelsRoute('telegram'));
        }}
      />
    </Box>
  );
}

function ActivityCard({
  bot,
  status,
}: {
  readonly bot: TelegramBot;
  readonly status: TelegramBotStatus | undefined;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const none = t('channels:telegram.detail.activity.none');
  const time = (iso: string | null | undefined): string =>
    iso == null ? none : clockTime(iso, locale);
  const rows: readonly (readonly [string, string])[] = [
    [t('channels:telegram.detail.activity.lastUpdate'), time(bot.health.lastUpdateAt)],
    [t('channels:telegram.detail.activity.lastReply'), time(status?.activity.lastReplyAt)],
    [
      t('channels:telegram.detail.activity.failed'),
      status === undefined ? none : String(status.activity.failedSends24h),
    ],
    [
      t('channels:telegram.detail.activity.open'),
      status === undefined ? none : String(status.activity.openTickets),
    ],
  ];

  return (
    <Card label={t('channels:telegram.detail.activity.heading')}>
      <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Typography variant="h3" component="h2" sx={{ fontSize: 16 }}>
          {t('channels:telegram.detail.activity.heading')}
        </Typography>
        <Box
          component="dl"
          sx={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) max-content',
            rowGap: 2,
            columnGap: 4,
            fontSize: 13,
            '& dt': { color: 'text.secondary' },
            '& dd': { margin: 0 },
          }}
        >
          {rows.map(([label, value]) => (
            <Box key={label} sx={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>
                <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
                  {value}
                </Typography>
              </dd>
            </Box>
          ))}
        </Box>
        <MuiLink component={Link} to={ROUTES.systemQueues} sx={{ fontSize: 13 }}>
          {t('channels:telegram.detail.activity.failedJobs')}
        </MuiLink>
      </Box>
    </Card>
  );
}
