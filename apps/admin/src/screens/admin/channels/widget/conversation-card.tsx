import type {
  CustomFieldDef,
  PrechatField,
  WidgetConversationSettings,
  WidgetSettings,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  IconButton,
  MenuItem,
  Link as MuiLink,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { GripVertical, Plus, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../../app/i18n.js';
import { ticketingRoute } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useChannelsApi } from '../../../../auth/session.tsx';
import { Field } from '../../../../ui/field.tsx';
import { visuallyHidden } from '../../../../ui/visually-hidden.js';
import { SectionCard, useEmailAction } from '../section-card.tsx';
import { moveField, prechatKeyOf } from './widget-draft.js';

/**
 * "Conversation" (M4-08; artboard `AdminWidget`): the pre-chat form and its
 * fields, the agent's name and photo, what happens when nobody is available,
 * and the transcript by email. The draft is the tab's, so the preview shows
 * the form as it is being edited.
 *
 * A field's order is changed with its handle: ArrowUp and ArrowDown on it,
 * as on the rule list (DESIGN §6.3).
 */
export function ConversationCard({
  brandId,
  draft,
  saved,
  customFields,
  onChange,
  onSaved,
}: {
  readonly brandId: string;
  readonly draft: WidgetConversationSettings;
  readonly saved: WidgetConversationSettings;
  /** The brand's ticket custom fields, for the "Add a custom field" list. */
  readonly customFields: readonly CustomFieldDef[];
  readonly onChange: (next: WidgetConversationSettings) => void;
  readonly onSaved: (settings: WidgetSettings) => void;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const tokens = useSemanticTokens();
  const id = useId();
  const [adding, setAdding] = useState('');

  const save = useEmailAction(
    (request: WidgetConversationSettings) => api.saveWidgetConversation(brandId, request),
    t('channels:widget.conversation.saved'),
    onSaved,
  );

  const set = <K extends keyof WidgetConversationSettings>(
    key: K,
    value: WidgetConversationSettings[K],
  ): void => {
    onChange({ ...draft, [key]: value });
  };
  const setFields = (fields: PrechatField[]): void => set('prechatFields', fields);

  const defByKey = new Map(customFields.map((def) => [def.key, def]));
  const nameOf = (field: PrechatField): string =>
    field.kind === 'custom'
      ? (defByKey.get(field.key)?.label ?? field.key)
      : t(`channels:widget.preview.${field.kind}`);
  const typeOf = (field: PrechatField): string =>
    field.kind === 'custom'
      ? t(`channels:widget.conversation.types.${defByKey.get(field.key)?.type ?? 'text'}`)
      : t(`channels:widget.conversation.types.${field.kind === 'email' ? 'email' : 'text'}`);
  const unused = customFields.filter(
    (def) => !draft.prechatFields.some((field) => field.kind === 'custom' && field.key === def.key),
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate(draft);
  };

  const onHandleKey = (event: KeyboardEvent, key: string): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setFields(moveField(draft.prechatFields, key, event.key === 'ArrowUp' ? -1 : 1));
    }
  };

  return (
    <SectionCard
      id={`${id}-conversation`}
      heading={t('channels:widget.conversation.heading')}
      caption={t('channels:widget.conversation.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button variant="text" disabled={save.isPending} onClick={() => onChange(saved)}>
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:widget.save')}
          </Button>
        </>
      }
    >
      <CheckRow
        id={`${id}-prechat`}
        checked={draft.prechatEnabled}
        label={t('channels:widget.conversation.prechat')}
        hint={t('channels:widget.conversation.prechatHint')}
        onChange={(checked) => set('prechatEnabled', checked)}
      />

      {draft.prechatEnabled ? (
        <Box sx={{ paddingInlineStart: 7, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <TableContainer
            sx={{ border: `1px solid ${tokens['border.default']}`, borderRadius: '6px' }}
          >
            <Table size="small" aria-label={t('channels:widget.conversation.fields')}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell sx={{ width: 40 }}>
                    <Box component="span" sx={visuallyHidden}>
                      {t('channels:widget.conversation.order')}
                    </Box>
                  </TableCell>
                  <TableCell>{t('channels:widget.conversation.field')}</TableCell>
                  <TableCell>{t('channels:widget.conversation.type')}</TableCell>
                  <TableCell sx={{ width: 88 }}>
                    {t('channels:widget.conversation.required')}
                  </TableCell>
                  <TableCell sx={{ width: 44 }}>
                    <Box component="span" sx={visuallyHidden}>
                      {t('channels:widget.conversation.remove')}
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {draft.prechatFields.map((field) => {
                  const key = prechatKeyOf(field);
                  const name = nameOf(field);
                  return (
                    <TableRow key={key}>
                      <TableCell>
                        <IconButton
                          size="small"
                          aria-label={t('channels:widget.conversation.reorder', { field: name })}
                          onKeyDown={(event) => onHandleKey(event, key)}
                        >
                          <GripVertical size={16} aria-hidden="true" />
                        </IconButton>
                      </TableCell>
                      <TableCell>
                        <Box
                          sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
                        >
                          <Typography sx={{ fontSize: 14 }}>{name}</Typography>
                          <Typography
                            variant="caption"
                            sx={{
                              paddingInline: '6px',
                              borderRadius: '6px',
                              backgroundColor: tokens['bg.muted'],
                              color: 'text.secondary',
                            }}
                          >
                            {field.kind === 'custom'
                              ? t('channels:widget.conversation.customField')
                              : t('channels:widget.conversation.builtIn')}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell>{typeOf(field)}</TableCell>
                      <TableCell>
                        <Checkbox
                          size="small"
                          checked={field.required}
                          onChange={(event) =>
                            setFields(
                              draft.prechatFields.map((held) =>
                                prechatKeyOf(held) === key
                                  ? { ...held, required: event.target.checked }
                                  : held,
                              ),
                            )
                          }
                          slotProps={{
                            input: {
                              'aria-label': t('channels:widget.conversation.requiredField', {
                                field: name,
                              }),
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        {field.kind === 'custom' ? (
                          <IconButton
                            size="small"
                            aria-label={t('channels:widget.conversation.removeField', {
                              field: name,
                            })}
                            onClick={() =>
                              setFields(
                                draft.prechatFields.filter((held) => prechatKeyOf(held) !== key),
                              )
                            }
                          >
                            <X size={16} aria-hidden="true" />
                          </IconButton>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 2, flexWrap: 'wrap' }}>
            <Field id={`${id}-add-field`} label={t('channels:widget.conversation.addLabel')}>
              <Select
                id={`${id}-add-field`}
                size="small"
                displayEmpty
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
                inputProps={{ 'aria-label': t('channels:widget.conversation.addLabel') }}
                sx={{ minWidth: 240 }}
              >
                <MenuItem value="">{t('channels:widget.conversation.addPlaceholder')}</MenuItem>
                {unused.map((def) => (
                  <MenuItem key={def.key} value={def.key}>
                    {def.label}
                  </MenuItem>
                ))}
              </Select>
            </Field>
            <Button
              variant="outlined"
              disabled={adding === ''}
              startIcon={<Plus size={16} aria-hidden="true" />}
              onClick={() => {
                setFields([
                  ...draft.prechatFields,
                  { kind: 'custom', key: adding, required: false },
                ]);
                setAdding('');
              }}
            >
              {t('channels:widget.conversation.add')}
            </Button>
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('channels:widget.conversation.fieldsHint')}{' '}
            <MuiLink component={Link} to={ticketingRoute('custom-fields')}>
              {t('channels:widget.conversation.fieldsLink')}
            </MuiLink>
          </Typography>
        </Box>
      ) : null}

      <CheckRow
        id={`${id}-agent`}
        checked={draft.showAgentIdentity}
        label={t('channels:widget.conversation.agent')}
        hint={t('channels:widget.conversation.agentHint')}
        onChange={(checked) => set('showAgentIdentity', checked)}
      />

      <Field
        id={`${id}-unavailable`}
        label={t('channels:widget.conversation.unavailable')}
        hint={t('channels:widget.conversation.unavailableHint')}
      >
        <Select
          id={`${id}-unavailable`}
          size="small"
          value={draft.whenUnavailable}
          onChange={(event) => set('whenUnavailable', event.target.value as 'form' | 'keep_chat')}
          inputProps={{
            'aria-label': t('channels:widget.conversation.unavailable'),
            'aria-describedby': `${id}-unavailable-hint`,
          }}
          sx={{ maxWidth: 360 }}
        >
          <MenuItem value="form">{t('channels:widget.conversation.unavailableForm')}</MenuItem>
          <MenuItem value="keep_chat">{t('channels:widget.conversation.unavailableKeep')}</MenuItem>
        </Select>
      </Field>

      <CheckRow
        id={`${id}-transcript`}
        checked={draft.transcriptEnabled}
        label={t('channels:widget.conversation.transcript')}
        hint={t('channels:widget.conversation.transcriptHint')}
        onChange={(checked) => set('transcriptEnabled', checked)}
      />
    </SectionCard>
  );
}

/** A checkbox with its label and a caption hint beside it, as the artboard draws every toggle here. */
export function CheckRow({
  id,
  checked,
  label,
  hint,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
      <Checkbox
        id={id}
        size="small"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        sx={{ padding: 0, marginBlockStart: '2px' }}
        slotProps={{
          input: hint === undefined ? {} : { 'aria-describedby': `${id}-hint` },
        }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <Typography component="label" htmlFor={id} sx={{ fontSize: 14, fontWeight: 500 }}>
          {label}
        </Typography>
        {hint === undefined ? null : (
          <Typography
            id={`${id}-hint`}
            variant="caption"
            sx={{ fontSize: 13, color: 'text.secondary' }}
          >
            {hint}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
