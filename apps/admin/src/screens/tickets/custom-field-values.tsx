import { isHttpsUrl } from '@helpdock/schemas';
import {
  Avatar,
  Box,
  Button,
  IconButton,
  Link,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { ExternalLink } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useCustomFieldPeople } from '../../tickets/use-people.js';
import { initialsOf } from '../contacts/format.js';

/**
 * How the M14-27 field types read and are chosen on a ticket
 * (`Admin/Ticketing-CustomFields`): a person by public name with an avatar, a
 * link that opens in a new tab, an email address as a left-to-right run, and a
 * long text collapsed to a few lines.
 *
 * A link is only ever an `<a href>` when it is an `https` address: the api
 * stores nothing else, but a stored value is data, so the check is made again
 * here before it reaches an attribute. Helpdock never fetches it.
 */

/** The `href` for a stored link, or `null` when it is not one the browser should be handed. */
export const safeHref = (value: unknown): string | null =>
  typeof value === 'string' && isHttpsUrl(value) ? new URL(value).href : null;

/** The brand's staff and whether the list has arrived, for the person controls. */
const usePeople = () => useCustomFieldPeople();

/** A person, as the field shows them: the avatar and the public name, or "Former staff member". */
export function PersonValue({ userId }: { readonly userId: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { people, loaded, failed } = usePeople();
  const person = people.find((candidate) => candidate.userId === userId);
  if (person === undefined && !loaded) {
    // Still reading, or the read failed: say nothing wrong about the person.
    return failed ? (
      <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
        {t('tickets:details.customNone')}
      </Typography>
    ) : null;
  }

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
      {person === undefined ? null : (
        <Avatar
          aria-hidden="true"
          sx={{
            width: 24,
            height: 24,
            fontSize: 12,
            fontWeight: 600,
            backgroundColor: tokens['action.primary.tint'],
            color: tokens['text.primary'],
          }}
        >
          {initialsOf(person.name)}
        </Avatar>
      )}
      <Typography
        variant="body2"
        component="span"
        sx={{ color: person === undefined ? 'text.secondary' : 'text.primary' }}
      >
        {person === undefined ? t('tickets:details.personFormer') : person.name}
      </Typography>
    </Box>
  );
}

/** The staff picker of a `person` field. A stored person who has left the brand stays selectable as "Former staff member" so the value is never silently dropped. */
export function PersonSelect({
  id,
  value,
  disabled,
  describedBy,
  invalid,
  label,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly label: string;
  onChange(next: string): void;
}): ReactNode {
  const t = useT();
  const { people, loaded } = usePeople();
  const former = value !== '' && loaded && !people.some((person) => person.userId === value);
  // Until the list arrives the select cannot show the stored name, so it holds an empty value rather than a mismatched one.
  const shown =
    value === '' || former || people.some((person) => person.userId === value) ? value : '';

  return (
    <TextField
      id={id}
      select
      size="small"
      disabled={disabled}
      value={shown}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      slotProps={{
        select: {
          displayEmpty: true,
          SelectDisplayProps: {
            'aria-label': label,
            'aria-invalid': invalid,
            'aria-describedby': describedBy,
          },
        },
      }}
    >
      <MenuItem value="">{t('tickets:details.personNone')}</MenuItem>
      {former ? <MenuItem value={value}>{t('tickets:details.personFormer')}</MenuItem> : null}
      {people.map((person) => (
        <MenuItem key={person.userId} value={person.userId}>
          {person.name}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** A link, read-only: opens in a new tab with `rel="noopener noreferrer"`; anything that is not `https` is shown as plain text. */
export function LinkValue({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}): ReactNode {
  const t = useT();
  const href = safeHref(value);
  if (href === null) {
    return (
      <Typography variant="body2" component="span" dir="ltr" sx={{ overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    );
  }

  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('tickets:details.linkOpen', { field: label })}
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, overflowWrap: 'anywhere' }}
    >
      <bdi dir="ltr">{href}</bdi>
      <ExternalLink size={14} aria-hidden="true" className="mirror-in-rtl" />
    </Link>
  );
}

/** The text box of a `link` field, with the way to open what is typed once it is an `https` address. Saves on blur or Enter, as the text types do. */
export function LinkInput({
  id,
  label,
  value,
  disabled,
  invalid,
  describedBy,
  onDraft,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
  onDraft(next: string): void;
  onCommit(next: string): void;
}): ReactNode {
  const t = useT();
  const href = safeHref(value.trim());

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <TextField
        id={id}
        size="small"
        fullWidth
        disabled={disabled}
        value={value}
        error={invalid}
        placeholder="https://"
        onChange={(event) => {
          onDraft(event.target.value);
        }}
        onBlur={(event) => {
          onCommit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            (event.target as HTMLInputElement).blur();
          }
        }}
        slotProps={{
          htmlInput: {
            'aria-invalid': invalid,
            'aria-describedby': describedBy,
            inputMode: 'url',
            // An address is a left-to-right run even in an Arabic desk.
            dir: 'ltr',
          },
        }}
      />
      {href === null ? null : (
        <IconButton
          component="a"
          size="small"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('tickets:details.linkOpen', { field: label })}
        >
          <ExternalLink size={16} aria-hidden="true" className="mirror-in-rtl" />
        </IconButton>
      )}
    </Box>
  );
}

/** An email address, read-only: a left-to-right run in any sentence. */
export function EmailValue({ value }: { readonly value: string }): ReactNode {
  return (
    <Typography variant="body2" component="span" sx={{ overflowWrap: 'anywhere' }}>
      <bdi dir="ltr">{value}</bdi>
    </Typography>
  );
}

/** A long text, read-only: three lines, and "Show all" when there is more. */
export function LongTextValue({ value }: { readonly value: string }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = value.length > 160 || value.split('\n').length > 3;

  return (
    <Box>
      <Typography
        variant="body2"
        sx={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          ...(open || !long
            ? {}
            : {
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }),
        }}
      >
        {value}
      </Typography>
      {long ? (
        <Button
          variant="text"
          size="small"
          aria-expanded={open}
          onClick={() => {
            setOpen((held) => !held);
          }}
        >
          {open ? t('tickets:details.showLess') : t('tickets:details.showAll')}
        </Button>
      ) : null}
    </Box>
  );
}
