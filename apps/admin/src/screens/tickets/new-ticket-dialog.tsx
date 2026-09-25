import type { ContactSummary, Department, TicketPriority } from '@helpdock/schemas';
import { normaliseIdentity, ticketPrioritySchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The 520 px dialog for a ticket typed in by hand.
 *
 * It has no artboard of its own: it is built to the `Admin/Staff` invite
 * dialog's pattern — title, one sentence, stacked fields, ghost Cancel then
 * primary — because that is the form pattern DESIGN §6.4 settled and a second
 * one would be a second answer to the same question.
 *
 * **The contact is a choice between three things**, not a required field. The
 * api takes `contactId` as optional, because M1-13's identity rules are what
 * attach somebody later; so an agent may search for a person, type a new one,
 * or file the ticket with nobody on it and let the first reply sort it out.
 */

export type NewTicketContact =
  | { readonly kind: 'existing'; readonly contactId: string }
  | { readonly kind: 'new'; readonly name: string; readonly email: string }
  | { readonly kind: 'none' };

export interface NewTicketValue {
  readonly contact: NewTicketContact;
  readonly subject: string;
  readonly departmentId: string;
  readonly priority: TicketPriority;
  readonly body: string;
}

type ContactMode = 'existing' | 'new' | 'none';

export function NewTicketDialog({
  open,
  departments,
  contacts,
  busy,
  onTermChange,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly departments: readonly Department[];
  /** What the contact search answered for the term last typed. */
  readonly contacts: readonly ContactSummary[];
  readonly busy: boolean;
  onTermChange(term: string): void;
  onSubmit(value: NewTicketValue): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const subjectId = useId();
  const departmentFieldId = useId();
  const priorityId = useId();
  const bodyId = useId();
  const searchId = useId();
  const nameId = useId();
  const emailId = useId();

  const [mode, setMode] = useState<ContactMode>('existing');
  const [term, setTerm] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // A dialog that reopened with the last ticket still in it would file the next
  // one against the wrong person on a mis-click.
  useEffect(() => {
    if (open) {
      setMode('existing');
      setTerm('');
      setContactId(null);
      setName('');
      setEmail('');
      setSubject('');
      setDepartmentId(departments[0]?.id ?? '');
      setPriority('medium');
      setBody('');
      setErrors({});
    }
  }, [open, departments]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found: Record<string, string> = {};

    if (subject.trim() === '') {
      found.subject = t('tickets:newTicket.subjectRequired');
    }
    if (body.trim() === '') {
      found.body = t('tickets:newTicket.messageRequired');
    }
    if (departmentId === '') {
      found.department = t('tickets:newTicket.departmentRequired');
    }
    if (mode === 'new') {
      if (name.trim() === '') {
        found.name = t('tickets:newTicket.nameRequired');
      }
      // Through the normaliser every channel and every screen goes through, so
      // the form and the api cannot disagree about what an address is.
      if (!normaliseIdentity('email', email).ok) {
        found.email = t('tickets:newTicket.emailInvalid');
      }
    }

    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }

    onSubmit({
      contact:
        mode === 'new'
          ? { kind: 'new', name: name.trim(), email: email.trim() }
          : mode === 'existing' && contactId !== null
            ? { kind: 'existing', contactId }
            : { kind: 'none' },
      subject: subject.trim(),
      departmentId,
      priority,
      body: body.trim(),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 520 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {t('tickets:newTicket.title')}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('tickets:newTicket.description')}
          </Typography>

          <Box>
            <Typography component="p" sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: '6px' }}>
              {t('tickets:newTicket.contactLabel')}
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={mode}
              aria-label={t('tickets:newTicket.contactLabel')}
              onChange={(_event, next: ContactMode | null) => {
                if (next !== null) {
                  setMode(next);
                }
              }}
            >
              <ToggleButton value="existing">{t('tickets:newTicket.existingContact')}</ToggleButton>
              <ToggleButton value="new">{t('tickets:newTicket.newContact')}</ToggleButton>
              <ToggleButton value="none">{t('tickets:newTicket.contactNone')}</ToggleButton>
            </ToggleButtonGroup>

            {mode === 'existing' ? (
              <Box sx={{ marginBlockStart: 3 }}>
                <TextField
                  id={searchId}
                  fullWidth
                  size="small"
                  type="search"
                  value={term}
                  placeholder={t('tickets:newTicket.contactPlaceholder')}
                  onChange={(event) => {
                    setTerm(event.target.value);
                    setContactId(null);
                    onTermChange(event.target.value);
                  }}
                  slotProps={{
                    htmlInput: { 'aria-label': t('tickets:newTicket.contactPlaceholder') },
                  }}
                />
                <Box
                  component="ul"
                  aria-label={t('tickets:newTicket.existingContact')}
                  sx={{
                    listStyle: 'none',
                    margin: 0,
                    marginBlockStart: 2,
                    padding: 0,
                    maxHeight: 160,
                    overflowY: 'auto',
                  }}
                >
                  {contacts.map((contact) => (
                    <Box component="li" key={contact.id}>
                      <Box
                        component="button"
                        type="button"
                        aria-pressed={contactId === contact.id}
                        onClick={() => {
                          setContactId(contact.id);
                        }}
                        sx={{
                          width: '100%',
                          textAlign: 'start',
                          border: 0,
                          cursor: 'pointer',
                          paddingInline: 3,
                          paddingBlock: 2,
                          borderRadius: '6px',
                          font: 'inherit',
                          backgroundColor:
                            contactId === contact.id
                              ? tokens['action.primary.tint']
                              : 'transparent',
                          '&:hover': { backgroundColor: tokens['bg.muted'] },
                        }}
                      >
                        <Typography variant="body2" component="span">
                          {contact.name}
                        </Typography>
                        {contact.primaryIdentity === null ? null : (
                          <Typography
                            variant="caption"
                            component="span"
                            sx={{ color: 'text.secondary', marginInlineStart: 2 }}
                          >
                            <bdi>{contact.primaryIdentity.value}</bdi>
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            ) : null}

            {mode === 'new' ? (
              <Box sx={{ marginBlockStart: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <TextField
                  id={nameId}
                  label={t('tickets:newTicket.nameLabel')}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  error={errors.name !== undefined}
                  helperText={errors.name ?? ' '}
                />
                <TextField
                  id={emailId}
                  type="email"
                  label={t('tickets:newTicket.emailLabel')}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  error={errors.email !== undefined}
                  helperText={errors.email ?? ' '}
                />
              </Box>
            ) : null}
          </Box>

          <TextField
            id={subjectId}
            label={t('tickets:newTicket.subjectLabel')}
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
            error={errors.subject !== undefined}
            helperText={errors.subject ?? ' '}
            autoFocus
          />

          <TextField
            id={departmentFieldId}
            select
            label={t('tickets:newTicket.departmentLabel')}
            value={departmentId}
            onChange={(event) => {
              setDepartmentId(event.target.value);
            }}
            error={errors.department !== undefined}
            helperText={
              departments.length === 0
                ? t('tickets:newTicket.noDepartments')
                : (errors.department ?? ' ')
            }
          >
            {departments.map((department) => (
              <MenuItem key={department.id} value={department.id}>
                {department.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            id={priorityId}
            select
            label={t('tickets:newTicket.priorityLabel')}
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

          <TextField
            id={bodyId}
            multiline
            minRows={4}
            label={t('tickets:newTicket.messageLabel')}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            error={errors.body !== undefined}
            helperText={errors.body ?? ' '}
          />
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t('tickets:newTicket.submit')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
