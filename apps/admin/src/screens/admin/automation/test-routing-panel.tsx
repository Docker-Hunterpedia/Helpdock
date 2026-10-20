import type {
  RoutingEntryPoint,
  RoutingOverview,
  RoutingTestLanguage,
  RuleBuilderOptions,
} from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useAutomationApi } from '../../../automation/context.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { Choice } from './choice.tsx';
import { RoutingResult } from './routing-result.tsx';
import { departmentName } from './routing-steps.tsx';
import type { RuleText } from './rule-text.js';

/**
 * Test routing (M14-09, `Admin/Automation-Routing`): a sample message walked
 * through the pipeline with nothing created, sent or logged. The panel says so
 * under its heading, as the rule test run does, and the result is a polite
 * live region.
 */

const keyOf = (door: Pick<RoutingEntryPoint, 'entry' | 'entryId'>): string =>
  `${door.entry}:${door.entryId ?? ''}`;

type HintKey = 'email' | 'telegram' | 'whatsapp' | 'messenger' | 'instagram';

const hintKey = (channel: RoutingEntryPoint['channel']): HintKey =>
  channel === 'telegram' ||
  channel === 'whatsapp' ||
  channel === 'messenger' ||
  channel === 'instagram'
    ? channel
    : 'email';

export function TestRoutingPanel({
  overview,
  options,
  text,
}: {
  readonly overview: RoutingOverview;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const brand = currentBrand(useSession());
  const api = useAutomationApi();

  const [entryKey, setEntryKey] = useState(() => {
    const first = overview.entryPoints[0];
    return first === undefined ? '' : keyOf(first);
  });
  const [apiDepartment, setApiDepartment] = useState('');
  const [from, setFrom] = useState('');
  const [fromName, setFromName] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [language, setLanguage] = useState<RoutingTestLanguage>('auto');

  const door = overview.entryPoints.find((candidate) => keyOf(candidate) === entryKey);
  const needsDepartment = door?.entry === 'api_key';
  // The reader's own departments: the overview is already narrowed to their scope.
  const departments = overview.assignment.map((entry) => entry.department);
  const takesSubject =
    door?.entry === 'mailbox' || door?.entry === 'web_form' || door?.entry === 'api_key';
  const chosenDepartment = apiDepartment === '' ? (departments[0]?.id ?? '') : apiDepartment;

  const test = useMutation({
    mutationFn: () => {
      if (door === undefined) {
        throw new Error('no entry point');
      }
      return api.testRouting(brand.id, {
        entry: door.entry,
        entryId: door.entryId,
        ...(needsDepartment ? { departmentId: chosenDepartment } : {}),
        from,
        fromName,
        subject: takesSubject ? subject : '',
        message,
        language,
      });
    },
  });

  return (
    <Box
      component="section"
      aria-labelledby="test-routing-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        minWidth: 0,
      }}
    >
      <Box
        component="form"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (door !== undefined && (!needsDepartment || chosenDepartment !== '')) {
            test.mutate();
          }
        }}
        sx={{
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Box>
          <Typography variant="h3" component="h2" id="test-routing-heading">
            {t('rules:routing.test.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('rules:routing.test.body')}
          </Typography>
        </Box>

        {door === undefined ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('rules:routing.test.noEntries')}
          </Typography>
        ) : (
          <>
            <Box
              sx={{
                display: 'grid',
                gap: 4,
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
              }}
            >
              <Field id="test-routing-entry" label={t('rules:routing.test.entry')}>
                <Choice id="test-routing-entry" value={entryKey} onChange={setEntryKey}>
                  {overview.entryPoints.map((candidate) => (
                    <option key={keyOf(candidate)} value={keyOf(candidate)}>
                      {entryOption(t, candidate)}
                    </option>
                  ))}
                </Choice>
              </Field>
              {needsDepartment ? (
                <Field id="test-routing-department" label={t('rules:routing.test.department')}>
                  <Choice
                    id="test-routing-department"
                    value={chosenDepartment}
                    onChange={setApiDepartment}
                  >
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {departmentName(department, locale)}
                      </option>
                    ))}
                  </Choice>
                </Field>
              ) : null}
            </Box>

            <Field
              id="test-routing-from"
              label={t('rules:routing.test.from')}
              hint={t(`rules:routing.test.fromHint.${hintKey(door.channel)}`)}
            >
              <TextField
                id="test-routing-from"
                size="small"
                value={from}
                onChange={(changed) => {
                  setFrom(changed.target.value);
                }}
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    style: { textAlign: 'start' },
                    'aria-describedby': fieldDescribedBy('test-routing-from', {
                      hint: t(`rules:routing.test.fromHint.${hintKey(door.channel)}`),
                    }),
                  },
                }}
              />
            </Field>

            <Field id="test-routing-name" label={t('rules:routing.test.fromName')}>
              <TextField
                id="test-routing-name"
                size="small"
                value={fromName}
                onChange={(changed) => {
                  setFromName(changed.target.value);
                }}
                slotProps={{ htmlInput: { dir: 'auto' } }}
              />
            </Field>
            {takesSubject ? (
              <Field id="test-routing-subject" label={t('rules:routing.test.subject')}>
                <TextField
                  id="test-routing-subject"
                  size="small"
                  value={subject}
                  onChange={(changed) => {
                    setSubject(changed.target.value);
                  }}
                  slotProps={{ htmlInput: { dir: 'auto' } }}
                />
              </Field>
            ) : null}

            <Field id="test-routing-message" label={t('rules:routing.test.message')}>
              <TextField
                id="test-routing-message"
                multiline
                minRows={2}
                size="small"
                value={message}
                onChange={(changed) => {
                  setMessage(changed.target.value);
                }}
                slotProps={{ htmlInput: { dir: 'auto' } }}
              />
            </Field>

            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                gap: 3,
              }}
            >
              <Field id="test-routing-language" label={t('rules:routing.test.language')}>
                <Choice
                  id="test-routing-language"
                  value={language}
                  onChange={(value) => {
                    setLanguage(value as RoutingTestLanguage);
                  }}
                >
                  {(['auto', 'en', 'ar'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`rules:routing.test.languages.${value}`)}
                    </option>
                  ))}
                </Choice>
              </Field>
              <Button
                type="submit"
                variant="contained"
                startIcon={<Play size={16} aria-hidden="true" />}
                disabled={test.isPending}
              >
                {t('rules:routing.test.run')}
              </Button>
            </Box>
          </>
        )}

        {test.isError ? (
          <Typography variant="caption" role="alert" sx={{ color: tokens['status.danger.text'] }}>
            {t('rules:routing.test.failed')}
          </Typography>
        ) : null}
      </Box>

      <Box aria-live="polite" sx={{ padding: test.data === undefined ? 0 : 4 }}>
        {test.data === undefined ? null : (
          <RoutingResult result={test.data} from={from} options={options} text={text} />
        )}
      </Box>
    </Box>
  );
}

const entryOption = (t: ReturnType<typeof useT>, door: RoutingEntryPoint): string => {
  const label = door.label ?? '';
  switch (door.entry) {
    case 'meta_account':
      return t('rules:routing.test.entryOption.meta_account', {
        label,
        channel: t(`rules:channels.${door.platform ?? 'whatsapp'}`),
      });
    case 'web_form':
      return t(
        door.enabled
          ? 'rules:routing.test.entryOption.web_form'
          : 'rules:routing.test.entryOption.web_formOff',
      );
    default:
      return t(`rules:routing.test.entryOption.${door.entry}`, { label });
  }
};
