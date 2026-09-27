import type { ImapTestResult, Mailbox } from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Inbox, PlugZap } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { channelsRoute, mailboxRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import {
  currentBrand,
  useChannelsApi,
  useSession,
  useTicketingApi,
} from '../../../auth/session.tsx';
import { isChannelsError } from '../../../channels/api.js';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { clockTime, shortDate } from './format.js';
import {
  type DraftErrors,
  type DraftField,
  draftFrom,
  isDirty,
  type MailboxDraft,
  testRequest,
  toUpdate,
  validate,
} from './mailbox-draft.js';
import { TestResult } from './test-result.tsx';

const INTERVALS = [30, 60, 120, 300] as const;

/**
 * The mailbox form (M2-08, the `Admin · mailbox form` artboard), for adding
 * one and for editing one: address and routing, incoming mail with Test IMAP,
 * and the security settings of M2-07, over a sticky "Unsaved changes" bar.
 *
 * A saved password is a masked field with Replace and nothing else; the
 * browser never holds it, so Test IMAP on a saved mailbox asks the api to use
 * the stored one.
 */
export function MailboxFormPage(): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());
  const { mailboxId } = useParams();
  const creating = mailboxId === undefined;

  const mailbox = useQuery({
    queryKey: ['mailbox', brand.id, mailboxId],
    queryFn: () => api.mailbox(brand.id, mailboxId ?? ''),
    enabled: !creating,
  });
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
  });

  if (!creating && mailbox.isError) {
    return (
      <EmptyState
        icon={Inbox}
        heading={t('channels:form.notFound.heading')}
        body={t('channels:form.notFound.body')}
        action={
          <Button variant="outlined" component={Link} to={channelsRoute('mailboxes')}>
            {t('channels:form.back')}
          </Button>
        }
      />
    );
  }

  if ((!creating && mailbox.data === undefined) || departments.data === undefined) {
    return <CircularProgress aria-label={t('channels:form.test.running')} />;
  }

  return (
    <MailboxForm
      key={mailbox.data?.id ?? 'new'}
      mailbox={mailbox.data}
      departments={departments.data.departments}
    />
  );
}

interface DepartmentOption {
  readonly id: string;
  readonly name: string;
  readonly nameAr: string | null;
}

function MailboxForm({
  mailbox,
  departments,
}: {
  readonly mailbox: Mailbox | undefined;
  readonly departments: readonly DepartmentOption[];
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const creating = mailbox === undefined;

  const saved = useMemo(() => draftFrom(mailbox, departments[0]?.id ?? ''), [mailbox, departments]);
  const [draft, setDraft] = useState<MailboxDraft>(saved);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [test, setTest] = useState<ImapTestResult | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const change = <K extends keyof MailboxDraft>(key: K, value: MailboxDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setRefusal(null);
  };

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['mailboxes', brand.id] });
    await queryClient.invalidateQueries({ queryKey: ['mailbox', brand.id] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const checked = validate(draft, { creating });
      if (!checked.ok) {
        setErrors(checked.errors);
        return undefined;
      }
      return creating
        ? api.createMailbox(brand.id, checked.request)
        : api.updateMailbox(brand.id, mailbox.id, toUpdate(checked.request, draft));
    },
    onSuccess: async (result) => {
      if (result === undefined) {
        return;
      }
      await refresh();
      toast({
        tone: 'success',
        message: t(creating ? 'channels:toast.created' : 'channels:toast.saved', {
          address: result.address,
        }),
      });
      if (creating) {
        void navigate(mailboxRoute(result.id), { replace: true });
      }
    },
    onError: (error: unknown) => {
      if (isChannelsError(error)) {
        setRefusal(t(`channels:refusal.${error.reason}`));
        if (error.reason === 'address-taken') {
          setErrors((current) => ({ ...current, address: 'email' }));
        }
        return;
      }
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const runTest = useMutation({
    mutationFn: async () => {
      const checked = testRequest(draft, mailbox?.id);
      if (!checked.ok) {
        setErrors((current) => ({ ...current, ...checked.errors }));
        return null;
      }
      return api.testImap(brand.id, checked.request);
    },
    onMutate: () => {
      setTest(null);
    },
    onSuccess: (result) => {
      setTest(result);
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteMailbox(brand.id, mailbox?.id ?? ''),
    onSuccess: async () => {
      await refresh();
      toast({
        tone: 'success',
        message: t('channels:toast.deleted', { address: mailbox?.address ?? '' }),
      });
      void navigate(channelsRoute('mailboxes'));
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const dirty = isDirty(draft, saved);
  const errorOf = (field: DraftField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : t(`channels:form.errors.${problem}`);
  };
  const departmentName = (id: string): string => {
    const found = departments.find((department) => department.id === id);
    return (locale === 'ar' ? found?.nameAr : null) ?? found?.name ?? '';
  };
  const failing = mailbox?.health.state === 'failing';

  return (
    <Box
      component="form"
      noValidate
      aria-label={creating ? t('channels:form.addTitle') : mailbox.address}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBlockEnd: 20 }}
    >
      <Box
        component="header"
        sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
      >
        <IconButton
          component={Link}
          to={channelsRoute('mailboxes')}
          aria-label={t('channels:form.back')}
          sx={{
            border: `1px solid ${tokens['border.strong']}`,
            borderRadius: '6px',
            width: 36,
            height: 36,
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" className="mirror-in-rtl" />
        </IconButton>
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography variant="h1" component="h1">
            {creating ? t('channels:form.addTitle') : <bdi>{mailbox.address}</bdi>}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
            {creating
              ? t('channels:form.captionAdd')
              : t('channels:form.captionEdit', {
                  department: departmentName(mailbox.departmentId),
                })}
          </Typography>
        </Box>
        {failing && mailbox.health.lastErrorKind !== null && mailbox.health.lastErrorAt !== null ? (
          <Box
            component="span"
            sx={{
              height: 22,
              paddingInline: 2,
              borderRadius: '999px',
              backgroundColor: tokens['status.danger.tint'],
              color: tokens['status.danger.text'],
              fontSize: 12,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              whiteSpace: 'nowrap',
            }}
          >
            <Box
              component="span"
              aria-hidden="true"
              sx={{
                width: 6,
                height: 6,
                borderRadius: '999px',
                backgroundColor: tokens['status.danger'],
              }}
            />
            {t('channels:health.since', {
              problem: t(`channels:health.${mailbox.health.lastErrorKind}`),
              time: clockTime(mailbox.health.lastErrorAt, locale),
            })}
          </Box>
        ) : null}
        {creating ? null : (
          <Button
            variant="outlined"
            color="error"
            sx={{ marginInlineStart: 'auto' }}
            onClick={() => {
              setDeleting(true);
            }}
          >
            {t('channels:form.delete')}
          </Button>
        )}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <Section
            heading={t('channels:form.address.heading')}
            caption={t('channels:form.address.caption')}
          >
            <Box sx={twoColumns}>
              <TextInput
                label={t('channels:form.address.email')}
                type="email"
                value={draft.address}
                error={errorOf('address')}
                onChange={(value) => {
                  change('address', value);
                }}
              />
              <TextInput
                label={t('channels:form.address.displayName')}
                hint={t('channels:form.address.displayNameHint')}
                value={draft.displayName}
                error={errorOf('displayName')}
                onChange={(value) => {
                  change('displayName', value);
                }}
              />
            </Box>
            <SelectInput
              label={t('channels:form.address.department')}
              hint={t('channels:form.address.departmentHint')}
              value={draft.departmentId}
              options={departments.map((department) => ({
                value: department.id,
                label: departmentName(department.id),
              }))}
              onChange={(value) => {
                change('departmentId', value);
              }}
            />
          </Section>

          <Section
            heading={t('channels:form.incoming.heading')}
            caption={t('channels:form.incoming.caption')}
          >
            <MethodChoice
              value={draft.method}
              onChange={(value) => {
                change('method', value);
                setTest(null);
              }}
            />
            {draft.method === 'imap' ? (
              <>
                <Box
                  sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px 140px', gap: 4 }}
                >
                  <TextInput
                    label={t('channels:form.incoming.host')}
                    value={draft.host}
                    mono
                    error={errorOf('host')}
                    onChange={(value) => {
                      change('host', value);
                    }}
                  />
                  <TextInput
                    label={t('channels:form.incoming.port')}
                    type="number"
                    value={draft.port}
                    error={errorOf('port')}
                    onChange={(value) => {
                      change('port', value);
                    }}
                  />
                  <SelectInput
                    label={t('channels:form.incoming.security')}
                    value={draft.security}
                    options={[
                      { value: 'tls', label: t('channels:form.incoming.securities.tls') },
                      { value: 'starttls', label: t('channels:form.incoming.securities.starttls') },
                    ]}
                    onChange={(value) => {
                      change('security', value === 'starttls' ? 'starttls' : 'tls');
                    }}
                  />
                </Box>
                <Box sx={twoColumns}>
                  <TextInput
                    label={t('channels:form.incoming.username')}
                    value={draft.username}
                    error={errorOf('username')}
                    onChange={(value) => {
                      change('username', value);
                    }}
                  />
                  <PasswordInput
                    mailbox={mailbox}
                    value={draft.password}
                    error={errorOf('password')}
                    onChange={(value) => {
                      change('password', value);
                    }}
                  />
                </Box>
                <Box sx={twoColumns}>
                  <TextInput
                    label={t('channels:form.incoming.folder')}
                    value={draft.folder}
                    mono
                    error={errorOf('folder')}
                    onChange={(value) => {
                      change('folder', value);
                    }}
                  />
                  <SelectInput
                    label={t('channels:form.incoming.pollEvery')}
                    value={String(draft.pollIntervalSeconds)}
                    options={INTERVALS.map((seconds) => ({
                      value: String(seconds),
                      label: t(`channels:form.incoming.intervals.${seconds}`),
                    }))}
                    onChange={(value) => {
                      const seconds = INTERVALS.find((interval) => String(interval) === value);
                      change('pollIntervalSeconds', seconds ?? 60);
                    }}
                  />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                  <Button
                    variant="outlined"
                    disabled={runTest.isPending}
                    aria-busy={runTest.isPending}
                    startIcon={
                      runTest.isPending ? (
                        <CircularProgress size={14} aria-hidden="true" />
                      ) : (
                        <PlugZap size={16} aria-hidden="true" />
                      )
                    }
                    onClick={() => {
                      runTest.mutate();
                    }}
                  >
                    {t('channels:form.test.button')}
                  </Button>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('channels:form.test.hint')}
                  </Typography>
                </Box>
                {test === null ? null : <TestResult result={test} folder={draft.folder} />}
              </>
            ) : null}
          </Section>
        </Box>

        <Section
          heading={t('channels:form.security.heading')}
          caption={t('channels:form.security.caption')}
        >
          <SecuritySettings draft={draft} allowlistError={errorOf('allowlist')} onChange={change} />
        </Section>
      </Box>

      <Box
        sx={{
          position: 'sticky',
          insetBlockEnd: 0,
          marginInline: -8,
          paddingBlock: 3,
          paddingInline: 8,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        {refusal === null ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }} aria-live="polite">
            {dirty ? t('channels:form.footer.unsaved') : ''}
          </Typography>
        ) : (
          <Typography variant="caption" role="alert" sx={{ color: tokens['status.danger.text'] }}>
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
            setTest(null);
          }}
        >
          {t('channels:form.footer.discard')}
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={save.isPending || (!creating && !dirty)}
        >
          {t(creating ? 'channels:form.footer.create' : 'channels:form.footer.save')}
        </Button>
      </Box>

      <ConfirmDialog
        open={deleting}
        title={t('channels:form.deleteConfirm.title', { address: mailbox?.address ?? '' })}
        body={t('channels:form.deleteConfirm.body')}
        confirmLabel={t('channels:form.deleteConfirm.action')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          remove.mutate();
        }}
        onClose={() => {
          setDeleting(false);
        }}
      />
    </Box>
  );
}

const twoColumns = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 4,
} as const;

function Section({
  heading,
  caption,
  children,
}: {
  readonly heading: string;
  readonly caption: string;
  readonly children: ReactNode;
}): ReactNode {
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
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          paddingBlock: 4,
          paddingInline: 5,
          borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}
      >
        <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
          {heading}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
          {caption}
        </Typography>
      </Box>
      <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</Box>
    </Box>
  );
}

function TextInput({
  label,
  value,
  hint,
  error,
  type = 'text',
  mono = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly type?: 'text' | 'email' | 'number' | 'password';
  readonly mono?: boolean;
  onChange(value: string): void;
}): ReactNode {
  const id = useId();

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <TextField
        id={id}
        size="small"
        type={type}
        value={value}
        error={error !== undefined}
        fullWidth
        onChange={(event) => {
          onChange(event.target.value);
        }}
        slotProps={{
          htmlInput: {
            'aria-describedby': fieldDescribedBy(id, { hint, error }),
            'aria-invalid': error !== undefined,
            ...(mono || type === 'email' ? { dir: 'ltr' } : {}),
          },
        }}
        sx={
          mono ? { '& input': (theme) => ({ ...theme.typography.mono, fontSize: 13 }) } : undefined
        }
      />
    </Field>
  );
}

function SelectInput({
  label,
  value,
  hint,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  onChange(value: string): void;
}): ReactNode {
  const id = useId();

  return (
    <Field id={id} label={label} hint={hint}>
      <Select
        id={id}
        size="small"
        value={value}
        fullWidth
        onChange={(event) => {
          onChange(String(event.target.value));
        }}
        inputProps={{ 'aria-label': label }}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </Field>
  );
}

function PasswordInput({
  mailbox,
  value,
  error,
  onChange,
}: {
  readonly mailbox: Mailbox | undefined;
  readonly value: string | null;
  readonly error: string | undefined;
  onChange(value: string | null): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const id = useId();
  const stored = mailbox?.imap ?? null;
  const hint =
    value === null && stored?.passwordUpdatedAt != null
      ? stored.passwordUpdatedByName === null
        ? t('channels:form.incoming.passwordSavedBySomeone', {
            date: shortDate(stored.passwordUpdatedAt, locale),
          })
        : t('channels:form.incoming.passwordSaved', {
            date: shortDate(stored.passwordUpdatedAt, locale),
            name: stored.passwordUpdatedByName,
          })
      : undefined;

  return (
    <Field id={id} label={t('channels:form.incoming.password')} hint={hint} error={error}>
      <Box sx={{ display: 'flex', gap: 2 }}>
        <TextField
          id={id}
          size="small"
          type="password"
          autoComplete="new-password"
          value={value ?? '••••••••••••'}
          error={error !== undefined}
          fullWidth
          onChange={(event) => {
            onChange(event.target.value);
          }}
          slotProps={{
            htmlInput: {
              readOnly: value === null,
              'aria-describedby': fieldDescribedBy(id, { hint, error }),
              'aria-invalid': error !== undefined,
            },
          }}
        />
        {value === null ? (
          <Button
            variant="outlined"
            onClick={() => {
              onChange('');
            }}
          >
            {t('channels:form.incoming.replacePassword')}
          </Button>
        ) : null}
      </Box>
    </Field>
  );
}

function MethodChoice({
  value,
  onChange,
}: {
  readonly value: MailboxDraft['method'];
  onChange(value: MailboxDraft['method']): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const legendId = useId();

  const option = (method: MailboxDraft['method'], title: string, hint: string): ReactNode => {
    const selected = value === method;

    return (
      <FormControlLabel
        value={method}
        control={<Radio size="small" />}
        sx={{
          margin: 0,
          alignItems: 'flex-start',
          gap: 1,
          paddingBlock: '10px',
          paddingInline: 3,
          borderRadius: '6px',
          border: selected
            ? `2px solid ${tokens['action.primary']}`
            : `1px solid ${tokens['border.strong']}`,
          backgroundColor: selected ? tokens['action.primary.tint'] : tokens['bg.surface'],
        }}
        label={
          <Box component="span" sx={{ display: 'flex', flexDirection: 'column' }}>
            <Typography component="span" sx={{ fontWeight: 500, fontSize: 14 }}>
              {title}
            </Typography>
            <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
              {hint}
            </Typography>
          </Box>
        }
      />
    );
  };

  return (
    <Box component="fieldset" sx={{ margin: 0, padding: 0, border: 0 }}>
      <Typography
        id={legendId}
        component="legend"
        sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: 2 }}
      >
        {t('channels:form.incoming.method')}
      </Typography>
      <RadioGroup
        aria-labelledby={legendId}
        value={value}
        onChange={(event) => {
          onChange(event.target.value === 'inbound_parse' ? 'inbound_parse' : 'imap');
        }}
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}
      >
        {option('imap', t('channels:form.incoming.imap'), t('channels:form.incoming.imapHint'))}
        {option(
          'inbound_parse',
          t('channels:form.incoming.parse'),
          t('channels:form.incoming.parseHint'),
        )}
      </RadioGroup>
    </Box>
  );
}

function SecuritySettings({
  draft,
  allowlistError,
  onChange,
}: {
  readonly draft: MailboxDraft;
  readonly allowlistError: string | undefined;
  onChange<K extends keyof MailboxDraft>(key: K, value: MailboxDraft[K]): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const imagesId = useId();
  const spfId = useId();
  const spfHintId = useId();
  const allowlistId = useId();

  const choice = (value: MailboxDraft['remoteImages'], title: string, hint: string): ReactNode => (
    <FormControlLabel
      value={value}
      control={<Radio size="small" />}
      sx={{ margin: 0, alignItems: 'flex-start', gap: 1 }}
      label={
        <Box component="span" sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography component="span" sx={{ fontWeight: 500, fontSize: 14 }}>
            {title}
          </Typography>
          <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
            {hint}
          </Typography>
        </Box>
      }
    />
  );

  return (
    <>
      <Box component="fieldset" sx={{ margin: 0, padding: 0, border: 0 }}>
        <Typography
          id={imagesId}
          component="legend"
          sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: 3 }}
        >
          {t('channels:form.security.images')}
        </Typography>
        <RadioGroup
          aria-labelledby={imagesId}
          value={draft.remoteImages}
          onChange={(event) => {
            onChange('remoteImages', event.target.value === 'proxy' ? 'proxy' : 'block');
          }}
          sx={{ gap: 3 }}
        >
          {choice(
            'block',
            t('channels:form.security.block'),
            t('channels:form.security.blockHint'),
          )}
          {choice(
            'proxy',
            t('channels:form.security.proxy'),
            t('channels:form.security.proxyHint'),
          )}
        </RadioGroup>
      </Box>

      <Box sx={{ height: '1px', backgroundColor: tokens['bg.muted'] }} />

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
        <Switch
          checked={draft.authFailureIsSpam}
          onChange={(event) => {
            onChange('authFailureIsSpam', event.target.checked);
          }}
          slotProps={{
            input: { 'aria-labelledby': spfId, 'aria-describedby': spfHintId, role: 'switch' },
          }}
        />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <Typography id={spfId} component="span" sx={{ fontWeight: 500, fontSize: 14 }}>
            {t('channels:form.security.spf')}
          </Typography>
          <Typography
            id={spfHintId}
            component="span"
            sx={{ fontSize: 13, color: 'text.secondary' }}
          >
            {t('channels:form.security.spfHint')}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ height: '1px', backgroundColor: tokens['bg.muted'] }} />

      <Field
        id={allowlistId}
        label={t('channels:form.security.allowlist')}
        hint={t('channels:form.security.allowlistHint')}
        error={allowlistError === undefined ? undefined : t('channels:form.errors.email')}
      >
        <TextField
          id={allowlistId}
          multiline
          minRows={2}
          value={draft.allowlist}
          error={allowlistError !== undefined}
          onChange={(event) => {
            onChange('allowlist', event.target.value);
          }}
          slotProps={{
            htmlInput: {
              dir: 'ltr',
              'aria-describedby': fieldDescribedBy(allowlistId, {
                hint: t('channels:form.security.allowlistHint'),
                error: allowlistError,
              }),
            },
          }}
        />
      </Field>
    </>
  );
}
