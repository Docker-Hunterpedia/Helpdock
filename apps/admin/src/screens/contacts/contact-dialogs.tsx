import type {
  Account,
  ContactDetail,
  ContactIdentityInput,
  ContactIdentityKind,
} from '@helpdock/schemas';
import { contactIdentityKindSchema } from '@helpdock/schemas';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
} from '@mui/material';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';

/**
 * The forms the contact screens open: a contact, an identifier and an account.
 *
 * Each is a controlled `<form>` inside a DESIGN §6.4 dialog, so `Enter` submits
 * and `Esc` closes, and each resets from its props every time it opens — a
 * dialog that remembers what was typed into it last time is a dialog that saves
 * the wrong thing.
 *
 * No field carries MUI's `required`, because it renders an asterisk and DESIGN
 * §6.1 bans one. What a form cannot do without, it refuses to submit: the
 * primary stays disabled until the name is there, which says the same thing
 * without a glyph nobody reads out.
 */

/** The kinds an agent may add by hand. A visitor id is issued, never typed. */
const TYPEABLE_KINDS: readonly ContactIdentityKind[] = contactIdentityKindSchema.options.filter(
  (kind) => kind !== 'visitor',
);

export interface ContactFormValue {
  readonly name: string;
  readonly accountId: string | null;
  readonly locale: 'en' | 'ar' | null;
  readonly timezone: string | null;
  readonly externalId: string | null;
  /** Only the create form collects one; editing manages identifiers separately. */
  readonly identity: ContactIdentityInput | null;
}

export function ContactDialog({
  open,
  contact,
  accounts,
  busy,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  /** Null for the create form. */
  readonly contact: ContactDetail | null;
  readonly accounts: readonly Account[];
  readonly busy: boolean;
  onClose(): void;
  onSubmit(value: ContactFormValue): void;
}): ReactNode {
  const t = useT();
  const fieldId = useId();
  const [name, setName] = useState(contact?.name ?? '');
  const [accountId, setAccountId] = useState(contact?.account?.id ?? '');
  const [locale, setLocale] = useState<'' | 'en' | 'ar'>(contact?.locale ?? '');
  const [timezone, setTimezone] = useState(contact?.timezone ?? '');
  const [externalId, setExternalId] = useState(contact?.externalId ?? '');
  const [kind, setKind] = useState<ContactIdentityKind>('email');
  const [value, setValue] = useState('');
  const [key, setKey] = useState(contact?.id ?? 'new');

  // Reset when the dialog is opened for a different contact. Deriving it from a
  // key rather than an effect keeps the fields in one render.
  const identity = contact?.id ?? 'new';
  if (open && key !== identity) {
    setKey(identity);
    setName(contact?.name ?? '');
    setAccountId(contact?.account?.id ?? '');
    setLocale(contact?.locale ?? '');
    setTimezone(contact?.timezone ?? '');
    setExternalId(contact?.externalId ?? '');
    setKind('email');
    setValue('');
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit({
      name: name.trim(),
      accountId: accountId === '' ? null : accountId,
      locale: locale === '' ? null : locale,
      timezone: timezone.trim() === '' ? null : timezone.trim(),
      externalId: externalId.trim() === '' ? null : externalId.trim(),
      identity: contact === null && value.trim() !== '' ? { kind, value: value.trim() } : null,
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={submit}>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {contact === null
            ? t('contacts:dialog.createTitle')
            : t('contacts:dialog.editTitle', { name: contact.name })}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBlock: 2 }}>
          <TextField
            id={`${fieldId}-name`}
            label={t('contacts:dialog.nameLabel')}
            value={name}
            size="small"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            id={`${fieldId}-account`}
            select
            label={t('contacts:dialog.accountLabel')}
            value={accountId}
            size="small"
            onChange={(event) => {
              setAccountId(event.target.value);
            }}
          >
            <MenuItem value="">{t('contacts:details.noAccount')}</MenuItem>
            {accounts.map((account) => (
              <MenuItem key={account.id} value={account.id}>
                {account.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            id={`${fieldId}-locale`}
            select
            label={t('contacts:dialog.localeLabel')}
            value={locale}
            size="small"
            onChange={(event) => {
              setLocale(event.target.value as '' | 'en' | 'ar');
            }}
          >
            <MenuItem value="">{t('common:placeholder.empty')}</MenuItem>
            <MenuItem value="en">English</MenuItem>
            <MenuItem value="ar">العربية</MenuItem>
          </TextField>
          <TextField
            id={`${fieldId}-timezone`}
            label={t('contacts:dialog.timezoneLabel')}
            value={timezone}
            size="small"
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          />
          <TextField
            id={`${fieldId}-external`}
            label={t('contacts:dialog.externalIdLabel')}
            value={externalId}
            size="small"
            onChange={(event) => {
              setExternalId(event.target.value);
            }}
          />

          {contact === null ? (
            <>
              <TextField
                id={`${fieldId}-kind`}
                select
                label={t('contacts:dialog.identityKindLabel')}
                value={kind}
                size="small"
                onChange={(event) => {
                  setKind(event.target.value as ContactIdentityKind);
                }}
              >
                {TYPEABLE_KINDS.map((option) => (
                  <MenuItem key={option} value={option}>
                    {t(`contacts:channel.${option}`)}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                id={`${fieldId}-value`}
                label={t('contacts:dialog.identityValueLabel')}
                value={value}
                size="small"
                helperText={t('contacts:identity.hint')}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            </>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || name.trim() === ''}>
            {contact === null ? t('contacts:dialog.createSubmit') : t('contacts:dialog.editSubmit')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function IdentityDialog({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  onClose(): void;
  onSubmit(value: ContactIdentityInput): void;
}): ReactNode {
  const t = useT();
  const fieldId = useId();
  const [kind, setKind] = useState<ContactIdentityKind>('email');
  const [value, setValue] = useState('');

  return (
    <Dialog
      open={open}
      onClose={() => {
        setValue('');
        onClose();
      }}
      maxWidth="xs"
      fullWidth
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ kind, value: value.trim() });
          setValue('');
        }}
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {t('contacts:identity.add')}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBlock: 2 }}>
          <TextField
            id={`${fieldId}-kind`}
            select
            label={t('contacts:identity.kindLabel')}
            value={kind}
            size="small"
            onChange={(event) => {
              setKind(event.target.value as ContactIdentityKind);
            }}
          >
            {TYPEABLE_KINDS.map((option) => (
              <MenuItem key={option} value={option}>
                {t(`contacts:channel.${option}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            id={`${fieldId}-value`}
            label={t('contacts:identity.valueLabel')}
            value={value}
            size="small"
            helperText={t('contacts:identity.hint')}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button
            variant="text"
            onClick={() => {
              setValue('');
              onClose();
            }}
            disabled={busy}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || value.trim() === ''}>
            {t('contacts:identity.add')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export interface AccountFormValue {
  readonly name: string;
  readonly domain: string | null;
}

export function AccountDialog({
  open,
  account,
  busy,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly account: Account | null;
  readonly busy: boolean;
  onClose(): void;
  onSubmit(value: AccountFormValue): void;
}): ReactNode {
  const t = useT();
  const fieldId = useId();
  const [name, setName] = useState(account?.name ?? '');
  const [domain, setDomain] = useState(account?.domain ?? '');
  const [key, setKey] = useState(account?.id ?? 'new');

  const identity = account?.id ?? 'new';
  if (open && key !== identity) {
    setKey(identity);
    setName(account?.name ?? '');
    setDomain(account?.domain ?? '');
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), domain: domain.trim() === '' ? null : domain.trim() });
        }}
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {account === null
            ? t('contacts:dialog.accountCreateTitle')
            : t('contacts:dialog.accountEditTitle', { name: account.name })}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBlock: 2 }}>
          <TextField
            id={`${fieldId}-name`}
            label={t('contacts:dialog.accountNameLabel')}
            value={name}
            size="small"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            id={`${fieldId}-domain`}
            label={t('contacts:dialog.accountDomainLabel')}
            value={domain}
            size="small"
            helperText={t('contacts:dialog.accountDomainHint')}
            onChange={(event) => {
              setDomain(event.target.value);
            }}
          />
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || name.trim() === ''}>
            {account === null
              ? t('contacts:dialog.accountCreateSubmit')
              : t('contacts:dialog.accountEditSubmit')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
