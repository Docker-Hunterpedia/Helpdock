import type {
  Department,
  TicketMessage,
  TicketPriority,
  TicketSplitRequest,
} from '@helpdock/schemas';
import { ticketPrioritySchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { Info, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { fileSize } from './attachment-chip.tsx';
import { messageTime } from './format.js';

/**
 * "Split into a new ticket" — panel 4 of `AdminTicketDialogs` (M1-09,
 * DOMAIN-RULES §2.4).
 *
 * The messages are listed oldest first and at least one must be ticked. The
 * contact is the original's and is not asked for; the department, subject and
 * priority are. The copy under the fields says what the api does — copies, not
 * moves; a fresh number and fresh clocks — because "split" alone reads as if
 * the messages leave the original.
 *
 * The artboard's primary button names the new ticket's number once the api
 * has answered. The number does not exist before then, so the button reads
 * "Create ticket" and the toast that follows names it.
 */
export function SplitDialog({
  open,
  messages,
  departments,
  defaultDepartmentId,
  defaultPriority,
  authorOf,
  now,
  busy,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  /** The ticket's own messages, oldest first. System rows are left out by the caller. */
  readonly messages: readonly TicketMessage[];
  /** The departments this person may file a ticket in. */
  readonly departments: readonly Department[];
  readonly defaultDepartmentId: string;
  readonly defaultPriority: TicketPriority;
  authorOf(message: TicketMessage): string;
  readonly now: number;
  readonly busy: boolean;
  onSubmit(request: TicketSplitRequest): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const titleId = useId();
  const legendId = useId();
  const subjectId = useId();
  const departmentId = useId();
  const priorityId = useId();

  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [subject, setSubject] = useState('');
  const [department, setDepartment] = useState(defaultDepartmentId);
  const [priority, setPriority] = useState<TicketPriority>(defaultPriority);
  const [errors, setErrors] = useState<{ messages?: string; subject?: string }>({});

  useEffect(() => {
    if (open) {
      setChosen(new Set());
      setSubject('');
      setDepartment(defaultDepartmentId);
      setPriority(defaultPriority);
      setErrors({});
    }
  }, [open, defaultDepartmentId, defaultPriority]);

  const toggle = (messageId: string): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) {
        next.add(messageId);
      }

      return next;
    });
    setErrors(({ subject: subjectError }) =>
      subjectError === undefined ? {} : { subject: subjectError },
    );
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = {
      ...(chosen.size === 0 ? { messages: t('tickets:split.pickOne') } : {}),
      ...(subject.trim() === '' ? { subject: t('tickets:split.subjectRequired') } : {}),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }

    onSubmit({
      // Oldest first, the order the api copies them in anyway.
      messageIds: messages.filter((message) => chosen.has(message.id)).map((message) => message.id),
      subject: subject.trim(),
      departmentId: department,
      priority,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 520 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, paddingInlineEnd: 4 }}>
          <DialogTitle id={titleId} sx={{ flex: 1, fontSize: 18, fontWeight: 600 }}>
            {t('tickets:split.title')}
            <Typography
              variant="body2"
              component="span"
              sx={{ display: 'block', color: 'text.secondary', fontWeight: 400 }}
            >
              {t('tickets:split.description')}
            </Typography>
          </DialogTitle>
          <IconButton
            size="small"
            aria-label={t('tickets:actions.closeDialog')}
            onClick={onClose}
            sx={{ marginBlockStart: 4 }}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box
            component="fieldset"
            aria-describedby={errors.messages === undefined ? undefined : `${legendId}-error`}
            sx={{
              border: 0,
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <Typography
              id={legendId}
              component="legend"
              sx={{ fontSize: 13, fontWeight: 500, paddingBlockEnd: '6px' }}
            >
              {t('tickets:split.messages', { count: chosen.size })}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                maxHeight: 260,
                overflowY: 'auto',
              }}
            >
              {messages.map((message) => {
                const ticked = chosen.has(message.id);

                return (
                  <Box
                    component="label"
                    key={message.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 3,
                      paddingBlock: 2,
                      paddingInline: 3,
                      borderRadius: '6px',
                      cursor: 'pointer',
                      border: `1px solid ${ticked ? tokens['action.primary'] : tokens['border.default']}`,
                      backgroundColor: ticked
                        ? tokens['action.primary.tint']
                        : tokens['bg.surface'],
                    }}
                  >
                    <Checkbox
                      size="small"
                      checked={ticked}
                      onChange={() => {
                        toggle(message.id);
                      }}
                      sx={{ padding: 0, marginBlockStart: '2px' }}
                    />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        component="span"
                        sx={{ color: 'text.secondary' }}
                      >
                        <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>
                          {authorOf(message)}
                        </Box>
                        {' · '}
                        <bdi>{messageTime(message.createdAt, locale, now)}</bdi>
                      </Typography>
                      <Typography variant="body2" component="span" noWrap sx={{ fontSize: 13 }}>
                        {excerptOf(message, (name, size) =>
                          t('tickets:split.attachmentLine', { name, size }),
                        )}
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
            {errors.messages === undefined ? null : (
              <Typography
                id={`${legendId}-error`}
                variant="caption"
                role="alert"
                sx={{ color: tokens['status.danger.text'] }}
              >
                {errors.messages}
              </Typography>
            )}
          </Box>

          <TextField
            id={subjectId}
            label={t('tickets:split.subject')}
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
            error={errors.subject !== undefined}
            helperText={errors.subject ?? ' '}
          />

          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
            <TextField
              id={departmentId}
              select
              label={t('tickets:split.department')}
              value={department}
              onChange={(event) => {
                setDepartment(event.target.value);
              }}
            >
              {departments.map((row) => (
                <MenuItem key={row.id} value={row.id}>
                  {row.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              id={priorityId}
              select
              label={t('tickets:split.priority')}
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as TicketPriority);
              }}
            >
              {ticketPrioritySchema.options.map((option) => (
                <MenuItem key={option} value={option}>
                  {t(`tickets:priority.${option}`)}
                </MenuItem>
              ))}
            </TextField>
          </Box>

          <Box sx={{ display: 'flex', gap: 2, color: 'text.secondary' }}>
            <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
            <Typography variant="body2" sx={{ fontSize: 13, color: 'inherit' }}>
              {t('tickets:split.note')}
            </Typography>
          </Box>
        </DialogContent>

        <DialogActions
          sx={{ padding: 4, gap: 2, borderBlockStart: `1px solid ${tokens['bg.muted']}` }}
        >
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t('tickets:split.submit')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

/**
 * One line of a message, for the checklist: its text, or — for a message that
 * is only a file, as the artboard's third row is — the file's name and size.
 */
const excerptOf = (
  message: TicketMessage,
  attachmentLine: (name: string, size: string) => string,
): string => {
  const text = message.bodyText.trim();
  if (text !== '') {
    return text;
  }

  return message.attachments
    .map((attachment) => attachmentLine(attachment.originalName, fileSize(attachment.size)))
    .join(', ');
};
