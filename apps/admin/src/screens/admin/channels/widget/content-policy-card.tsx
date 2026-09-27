import {
  ATTACHMENTS_PER_MESSAGE_CEILING,
  type ContentPolicy,
  type WidgetSettings,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useChannelsApi } from '../../../../auth/session.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { SectionCard, useEmailAction } from '../section-card.tsx';
import { CheckRow } from './conversation-card.tsx';
import {
  POLICY_KINDS,
  type PolicyDraft,
  type PolicyKind,
  type PolicyProblem,
  policyDraftOf,
  policyRequestOf,
  UPLOAD_LIMIT_MB,
} from './widget-draft.js';

const HINTS: Readonly<Record<PolicyKind, 'imageHint' | 'videoHint' | 'voiceHint' | null>> = {
  image: 'imageHint',
  video: 'videoHint',
  voice: 'voiceHint',
  file: null,
};

/**
 * "What visitors can send" (M4-07; artboard `AdminWidget`): each kind on or
 * off, its size cap in MB and its MIME types, and attachments per message.
 * It edits the brand's one content policy (M1-10), which the api enforces at
 * presign, at confirm and in the media worker for every channel.
 */
export function ContentPolicyCard({
  brandId,
  policy,
  onSaved,
}: {
  readonly brandId: string;
  readonly policy: ContentPolicy;
  readonly onSaved: (settings: WidgetSettings) => void;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const tokens = useSemanticTokens();
  const id = useId();
  const [draft, setDraft] = useState<PolicyDraft>(() => policyDraftOf(policy));
  const [problems, setProblems] = useState<ReadonlySet<PolicyProblem>>(new Set());

  useEffect(() => {
    setDraft(policyDraftOf(policy));
  }, [policy]);

  const save = useEmailAction(
    (request: ContentPolicy) => api.saveWidgetContentPolicy(brandId, request),
    t('channels:widget.policy.saved'),
    onSaved,
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const outcome = policyRequestOf(draft, policy);
    setProblems(outcome.ok ? new Set() : outcome.problems);
    if (outcome.ok) {
      save.mutate(outcome.request);
    }
  };

  const setKind = (kind: PolicyKind, patch: Partial<PolicyDraft['kinds'][PolicyKind]>): void => {
    setDraft((held) => ({
      ...held,
      kinds: { ...held.kinds, [kind]: { ...held.kinds[kind], ...patch } },
    }));
  };

  const perMessageError = problems.has('perMessage')
    ? t('channels:widget.policy.badPerMessage', { max: ATTACHMENTS_PER_MESSAGE_CEILING })
    : undefined;
  const perMessageHint = t('channels:widget.policy.perMessageHint');

  return (
    <SectionCard
      id={`${id}-policy`}
      heading={t('channels:widget.policy.heading')}
      caption={t('channels:widget.policy.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(policyDraftOf(policy));
              setProblems(new Set());
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:widget.save')}
          </Button>
        </>
      }
    >
      <TableContainer sx={{ border: `1px solid ${tokens['border.default']}`, borderRadius: '6px' }}>
        <Table size="small" aria-label={t('channels:widget.policy.table')}>
          <TableHead>
            <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableCell>{t('channels:widget.policy.kind')}</TableCell>
              <TableCell sx={{ width: 120 }}>{t('channels:widget.policy.maxSize')}</TableCell>
              <TableCell>{t('channels:widget.policy.types')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>
                <CheckRow
                  id={`${id}-text`}
                  checked
                  disabled
                  label={t('channels:widget.policy.text')}
                  hint={t('channels:widget.policy.alwaysOn')}
                  onChange={() => undefined}
                />
              </TableCell>
              <TableCell aria-hidden="true">—</TableCell>
              <TableCell aria-hidden="true">—</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <CheckRow
                  id={`${id}-emoji`}
                  checked={draft.emoji}
                  label={t('channels:widget.policy.emoji')}
                  onChange={(checked) => setDraft((held) => ({ ...held, emoji: checked }))}
                />
              </TableCell>
              <TableCell aria-hidden="true">—</TableCell>
              <TableCell aria-hidden="true">—</TableCell>
            </TableRow>
            {POLICY_KINDS.map((kind) => {
              const held = draft.kinds[kind];
              const name = t(`channels:widget.policy.${kind}`);
              const hint = HINTS[kind];
              const sizeError = problems.has(`size:${kind}`)
                ? t('channels:widget.policy.badSize')
                : problems.has(`tooLarge:${kind}`)
                  ? t('channels:widget.policy.tooLarge', { limit: UPLOAD_LIMIT_MB })
                  : undefined;
              const typesError = problems.has(`types:${kind}`)
                ? t('channels:widget.policy.badTypes')
                : undefined;
              const errorId = `${id}-${kind}-error`;
              return (
                <TableRow key={kind}>
                  <TableCell>
                    <CheckRow
                      id={`${id}-${kind}`}
                      checked={held.enabled}
                      label={name}
                      {...(hint === null ? {} : { hint: t(`channels:widget.policy.${hint}`) })}
                      onChange={(checked) => setKind(kind, { enabled: checked })}
                    />
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <TextField
                        size="small"
                        value={held.maxMb}
                        disabled={!held.enabled}
                        error={sizeError !== undefined}
                        onChange={(event) => setKind(kind, { maxMb: event.target.value })}
                        slotProps={{
                          htmlInput: {
                            inputMode: 'numeric',
                            dir: 'ltr',
                            'aria-label': t('channels:widget.policy.sizeLabel', { kind: name }),
                            'aria-invalid': sizeError !== undefined,
                            ...(sizeError === undefined ? {} : { 'aria-describedby': errorId }),
                          },
                        }}
                        sx={{ width: 72 }}
                      />
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {t('channels:widget.policy.mb')}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      fullWidth
                      value={held.types}
                      disabled={!held.enabled}
                      error={typesError !== undefined}
                      onChange={(event) => setKind(kind, { types: event.target.value })}
                      slotProps={{
                        htmlInput: {
                          dir: 'ltr',
                          spellCheck: false,
                          'aria-label': t('channels:widget.policy.typesLabel', { kind: name }),
                          'aria-invalid': typesError !== undefined,
                          ...(typesError === undefined ? {} : { 'aria-describedby': errorId }),
                        },
                      }}
                    />
                    {sizeError === undefined && typesError === undefined ? null : (
                      <Typography
                        id={errorId}
                        role="alert"
                        variant="caption"
                        sx={{
                          display: 'block',
                          marginBlockStart: 1,
                          color: tokens['status.danger.text'],
                        }}
                      >
                        {[sizeError, typesError].filter((line) => line !== undefined).join(' ')}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Field
        id={`${id}-per-message`}
        label={t('channels:widget.policy.perMessage')}
        hint={perMessageHint}
        error={perMessageError}
      >
        <TextField
          id={`${id}-per-message`}
          size="small"
          value={draft.perMessage}
          error={perMessageError !== undefined}
          onChange={(event) => setDraft((held) => ({ ...held, perMessage: event.target.value }))}
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              dir: 'ltr',
              'aria-describedby': fieldDescribedBy(`${id}-per-message`, {
                hint: perMessageHint,
                error: perMessageError,
              }),
            },
          }}
          sx={{ width: 96 }}
        />
      </Field>
    </SectionCard>
  );
}
