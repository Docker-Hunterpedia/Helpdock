import type {
  CustomFieldDef,
  DepartmentSummary,
  TagSummary,
  TicketPriority,
  TicketTemplate,
  TicketTemplatePreview,
} from '@helpdock/schemas';
import {
  TEMPLATE_BODY_MAX,
  TEMPLATE_NAME_MAX_LENGTH,
  TEMPLATE_PLACEHOLDERS,
  TICKET_SUBJECT_MAX,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field } from '../../../ui/field.tsx';
import { CustomDefaultField } from './custom-default-field.tsx';
import { TagChip } from './tag-chip.tsx';

/**
 * The editor card of the Templates tab.
 *
 * **The preview is the api's.** The button asks the server to render the
 * template and shows what comes back, rather than filling the placeholders in
 * the browser: the renderer is what decides which names a placeholder may
 * reach, and a second implementation here would be a second answer to that
 * (`apps/api/src/ticketing/template-render.ts`).
 *
 * **The body is a plain textarea.** M5's TipTap is the rich composer; a
 * half-rich editor now would be a migration later.
 *
 * Custom field defaults are offered only for the *ticket* fields, because that
 * is what a template makes.
 */

export interface TemplateDraft {
  readonly name: string;
  readonly departmentId: string | null;
  readonly priority: TicketPriority;
  readonly subject: string;
  readonly bodyText: string;
  readonly defaultTagIds: readonly string[];
  readonly customDefaults: Record<string, unknown>;
}

export function TemplateEditor({
  template,
  departments,
  tags,
  ticketFields,
  preview,
  busy,
  onSubmit,
  onCancel,
  onPreview,
  onClosePreview,
  onDelete,
}: {
  readonly template: TicketTemplate | null;
  readonly departments: readonly DepartmentSummary[];
  readonly tags: readonly TagSummary[];
  /** The brand's *ticket* custom fields; a template fills those and no others. */
  readonly ticketFields: readonly CustomFieldDef[];
  readonly preview: TicketTemplatePreview | null;
  readonly busy: boolean;
  onSubmit(draft: TemplateDraft): void;
  onCancel(): void;
  onPreview(): void;
  onClosePreview(): void;
  onDelete?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const nameId = useId();
  const departmentId = useId();
  const priorityId = useId();
  const subjectId = useId();
  const bodyId = useId();

  const [name, setName] = useState(template?.name ?? '');
  const [department, setDepartment] = useState(template?.departmentId ?? '');
  const [priority, setPriority] = useState<TicketPriority>(template?.priority ?? 'medium');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [bodyText, setBodyText] = useState(template?.bodyText ?? '');
  const [tagIds, setTagIds] = useState<readonly string[]>(template?.defaultTagIds ?? []);
  const [defaults, setDefaults] = useState<Record<string, unknown>>(template?.customDefaults ?? {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different template" is its id.
  useEffect(() => {
    setName(template?.name ?? '');
    setDepartment(template?.departmentId ?? '');
    setPriority(template?.priority ?? 'medium');
    setSubject(template?.subject ?? '');
    setBodyText(template?.bodyText ?? '');
    setTagIds(template?.defaultTagIds ?? []);
    setDefaults(template?.customDefaults ?? {});
  }, [template?.id]);

  const complete = name.trim() !== '' && subject.trim() !== '' && bodyText.trim() !== '';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!complete) {
      return;
    }

    onSubmit({
      name: name.trim(),
      departmentId: department === '' ? null : department,
      priority,
      subject: subject.trim(),
      bodyText: bodyText.trim(),
      defaultTagIds: tagIds,
      customDefaults: defaults,
    });
  };

  const heading =
    template === null
      ? t('ticketing:templates.editor.newHeading')
      : t('ticketing:templates.editor.heading');

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={heading}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2">
        {heading}
      </Typography>

      <Field id={nameId} label={t('ticketing:templates.editor.name')}>
        <TextField
          id={nameId}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: TEMPLATE_NAME_MAX_LENGTH } }}
        />
      </Field>

      <Field id={departmentId} label={t('ticketing:templates.editor.department')}>
        <Select
          id={departmentId}
          value={departments.some((row) => row.id === department) ? department : ''}
          onChange={(event) => {
            setDepartment(event.target.value);
          }}
          size="small"
          displayEmpty
          inputProps={{ 'aria-label': t('ticketing:templates.editor.department') }}
        >
          <MenuItem value="">{t('ticketing:templates.anyDepartment')}</MenuItem>
          {departments.map((row) => (
            <MenuItem key={row.id} value={row.id}>
              {row.name}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Field id={priorityId} label={t('ticketing:templates.editor.priority')}>
        <Select
          id={priorityId}
          value={priority}
          onChange={(event) => {
            setPriority(event.target.value as TicketPriority);
          }}
          size="small"
          inputProps={{ 'aria-label': t('ticketing:templates.editor.priority') }}
        >
          {ticketPrioritySchema.options.map((candidate) => (
            <MenuItem key={candidate} value={candidate}>
              {t(`ticketing:templates.priorities.${candidate}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Field id={subjectId} label={t('ticketing:templates.editor.subject')}>
        <TextField
          id={subjectId}
          value={subject}
          onChange={(event) => {
            setSubject(event.target.value);
          }}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: TICKET_SUBJECT_MAX } }}
        />
      </Field>

      {/* The names, as themselves. They are written in the catalog nowhere:
          `TEMPLATE_PLACEHOLDERS` is the one list, and the renderer reads the
          same one, so the hint cannot drift from what the api will fill. */}
      <Box>
        <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
          {t('ticketing:templates.editor.subjectHint')}
        </Typography>
        <Typography
          component="p"
          dir="ltr"
          sx={{ fontFamily: 'monospace', fontSize: 13, color: 'text.secondary' }}
        >
          {TEMPLATE_PLACEHOLDERS.map((placeholder) => `{{${placeholder}}}`).join(' · ')}
        </Typography>
      </Box>

      <Field
        id={bodyId}
        label={t('ticketing:templates.editor.body')}
        hint={t('ticketing:templates.editor.bodyHint')}
      >
        <TextField
          id={bodyId}
          value={bodyText}
          onChange={(event) => {
            setBodyText(event.target.value);
          }}
          size="small"
          required
          multiline
          minRows={4}
          slotProps={{ htmlInput: { maxLength: TEMPLATE_BODY_MAX } }}
        />
      </Field>

      <Box role="group" aria-label={t('ticketing:templates.editor.defaultTags')}>
        <Typography
          component="p"
          sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', marginBlockEnd: '6px' }}
        >
          {t('ticketing:templates.editor.defaultTags')}
        </Typography>
        {tags.map((tag) => (
          <FormControlLabel
            key={tag.id}
            sx={{ display: 'flex' }}
            control={
              <Checkbox
                checked={tagIds.includes(tag.id)}
                onChange={(event) => {
                  setTagIds(
                    event.target.checked
                      ? [...tagIds, tag.id]
                      : tagIds.filter((id) => id !== tag.id),
                  );
                }}
                slotProps={{ input: { 'aria-label': tag.name } }}
              />
            }
            label={<TagChip tag={tag} />}
          />
        ))}
        <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
          {t('ticketing:templates.editor.defaultTagsHint')}
        </Typography>
      </Box>

      {ticketFields.length === 0 ? null : (
        <Box role="group" aria-label={t('ticketing:templates.editor.customDefaults')}>
          <Typography
            component="p"
            sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', marginBlockEnd: '6px' }}
          >
            {t('ticketing:templates.editor.customDefaults')}
          </Typography>
          {ticketFields.map((field) => (
            <CustomDefaultField
              key={field.id}
              def={field}
              value={defaults[field.key]}
              disabled={busy}
              onChange={(next) => {
                const updated = { ...defaults };
                if (next === undefined) {
                  delete updated[field.key];
                } else {
                  updated[field.key] = next;
                }
                setDefaults(updated);
              }}
            />
          ))}
        </Box>
      )}

      {preview === null ? null : (
        <Box
          sx={{
            padding: 4,
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.canvas'],
          }}
        >
          <Typography variant="h3" component="h3">
            {t('ticketing:templates.editor.previewHeading')}
          </Typography>
          <Typography sx={{ fontWeight: 500, marginBlockStart: 2 }}>{preview.subject}</Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', marginBlockStart: 2 }}>
            {preview.bodyText}
          </Typography>
          {preview.unknownPlaceholders.length === 0 ? null : (
            <Typography
              variant="caption"
              component="p"
              sx={{ color: tokens['status.warning.text'], marginBlockStart: 2 }}
            >
              {t('ticketing:templates.editor.unknownPlaceholders', {
                names: preview.unknownPlaceholders.join(', '),
              })}
            </Typography>
          )}
          <Button variant="text" onClick={onClosePreview} sx={{ marginBlockStart: 2 }}>
            {t('ticketing:templates.editor.previewClose')}
          </Button>
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        {template === null ? null : (
          <Button variant="outlined" onClick={onPreview} disabled={busy}>
            {t('ticketing:templates.editor.preview')}
          </Button>
        )}
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || !complete}>
          {template === null
            ? t('ticketing:templates.editor.create')
            : t('ticketing:templates.editor.save')}
        </Button>
      </Box>

      {onDelete === undefined ? null : (
        <Button
          variant="text"
          color="error"
          onClick={onDelete}
          disabled={busy}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('ticketing:templates.editor.delete')}
        </Button>
      )}
    </Box>
  );
}
