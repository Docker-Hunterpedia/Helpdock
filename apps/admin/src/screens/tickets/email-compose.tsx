import type { MessageDelivery } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Link as MuiLink,
  TextField,
  Typography,
} from '@mui/material';
import { RotateCw, TriangleAlert, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The composer's email mode and the thread's failed-delivery state (artboard
 * `AdminTicketEmail`, M2-05): who a public reply goes out as, who it goes to,
 * the signature it will carry, and — under a reply the mail server refused
 * five times — "Not delivered · Retry".
 */

export interface ComposerEmail {
  readonly senders: readonly { readonly key: string; readonly label: string }[];
  readonly fromKey: string | null;
  onFromChange(key: string): void;
  readonly to: { readonly name: string; readonly address: string } | null;
  readonly ccs: readonly { readonly id: string; readonly address: string }[];
  readonly busy: boolean;
  onAddCc(address: string): void;
  onRemoveCc(id: string, address: string): void;
  readonly signature: string | null;
}

/** The From select, beside the Reply / Internal note control. */
export function FromSelect({ email }: { readonly email: ComposerEmail }): ReactNode {
  const t = useT();
  const id = useId();

  if (email.senders.length === 0) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:email.noSender')}
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
      <Typography component="label" htmlFor={id} variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:email.from')}
      </Typography>
      <TextField
        id={id}
        select
        size="small"
        value={email.fromKey ?? ''}
        onChange={(event) => {
          email.onFromChange(event.target.value);
        }}
        sx={{ minWidth: 0, maxWidth: 360 }}
        slotProps={{ select: { inputProps: { 'aria-label': t('tickets:email.from') } } }}
      >
        {email.senders.map((sender) => (
          <MenuItem key={sender.key} value={sender.key}>
            <bdi>{sender.label}</bdi>
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

/** A recipient as a chip: name and address, with a remove button when it can go. */
function RecipientChip({
  name,
  address,
  onRemove,
  removeLabel,
}: {
  readonly name: string | null;
  readonly address: string;
  readonly onRemove?: (() => void) | undefined;
  readonly removeLabel?: string | undefined;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="li"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        height: 24,
        paddingInlineStart: 2,
        paddingInlineEnd: onRemove === undefined ? 2 : '2px',
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.muted'],
        fontSize: 12,
        maxWidth: '100%',
      }}
    >
      {name === null || name === '' ? null : (
        <Typography component="span" sx={{ fontSize: 12, fontWeight: 500 }}>
          {name}
        </Typography>
      )}
      <Typography
        component="bdi"
        sx={{ fontSize: 12, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {address}
      </Typography>
      {onRemove === undefined ? null : (
        <IconButton
          size="small"
          aria-label={removeLabel}
          onClick={onRemove}
          sx={{ padding: '2px' }}
        >
          <X size={12} aria-hidden="true" />
        </IconButton>
      )}
    </Box>
  );
}

/** The To and Cc lines. The To is the contact; the Cc are the ticket's CC participants. */
export function RecipientLines({ email }: { readonly email: ComposerEmail }): ReactNode {
  const t = useT();
  const id = useId();
  const [address, setAddress] = useState('');

  if (email.to === null) {
    return (
      <Typography variant="caption" role="note" sx={{ color: 'text.secondary' }}>
        {t('tickets:email.noAddress')}
      </Typography>
    );
  }

  const add = (event: FormEvent | { preventDefault(): void }): void => {
    event.preventDefault();
    const trimmed = address.trim();
    if (trimmed !== '') {
      email.onAddCc(trimmed);
      setAddress('');
    }
  };

  const list = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 1,
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: 3,
        rowGap: 2,
      }}
    >
      <Typography id={`${id}-to`} variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:email.to')}
      </Typography>
      <Box component="ul" aria-labelledby={`${id}-to`} sx={list}>
        <RecipientChip name={email.to.name} address={email.to.address} />
      </Box>

      <Typography id={`${id}-cc`} variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:email.cc')}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        {email.ccs.length === 0 ? null : (
          <Box component="ul" aria-labelledby={`${id}-cc`} sx={list}>
            {email.ccs.map((cc) => (
              <RecipientChip
                key={cc.id}
                name={null}
                address={cc.address}
                removeLabel={t('tickets:email.removeCc', { address: cc.address })}
                onRemove={
                  email.busy
                    ? undefined
                    : () => {
                        email.onRemoveCc(cc.id, cc.address);
                      }
                }
              />
            ))}
          </Box>
        )}
        <TextField
          size="small"
          type="email"
          variant="standard"
          value={address}
          placeholder={t('tickets:email.addCc')}
          disabled={email.busy}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              add(event);
            }
          }}
          onBlur={() => {
            if (address.trim() !== '') {
              add({ preventDefault: () => undefined });
            }
          }}
          sx={{ minWidth: 160, flex: '1 1 160px' }}
          slotProps={{
            htmlInput: { 'aria-label': t('tickets:email.addCc'), dir: 'ltr' },
          }}
        />
      </Box>
    </Box>
  );
}

/** "Signature · added when sent", under the textarea, with the way to change it. */
export function SignaturePreview({ signature }: { readonly signature: string | null }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const lines = (signature ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 3,
        paddingBlockStart: 2,
        borderBlockStart: `1px dashed ${tokens['border.default']}`,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        {lines.length === 0 ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('tickets:email.noSignature')}
          </Typography>
        ) : (
          lines.map((line, index) => (
            <Typography
              // Lines of one signature never reorder while it is shown.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              key={index}
              variant="caption"
              sx={index === 0 ? { fontWeight: 500 } : { color: 'text.secondary' }}
            >
              {line}
            </Typography>
          ))
        )}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:email.signatureCaption')}
      </Typography>
      <MuiLink component={Link} to={ROUTES.signature} variant="caption">
        {lines.length === 0 ? t('tickets:email.addSignature') : t('tickets:email.editSignature')}
      </MuiLink>
    </Box>
  );
}

/**
 * Under an outbound reply that did not reach the customer: the relay's last
 * words and how many attempts, and Retry. Nothing is drawn for a reply that
 * was sent or is still on its way.
 */
export function DeliveryFailure({
  delivery,
  busy,
  onRetry,
}: {
  readonly delivery: MessageDelivery;
  readonly busy: boolean;
  onRetry(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (delivery.status !== 'failed' && delivery.status !== 'discarded') {
    return null;
  }

  const detail =
    delivery.status === 'discarded'
      ? t('tickets:email.discarded')
      : t('tickets:email.notDeliveredDetail', {
          error: delivery.lastError ?? '—',
          attempts: delivery.attempts,
        });

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        marginBlockStart: 2,
        paddingBlock: 1,
        paddingInline: 3,
        borderRadius: '6px',
        border: `1px solid ${tokens['status.danger']}`,
        backgroundColor: tokens['status.danger.tint'],
        color: tokens['status.danger.text'],
      }}
    >
      <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
      <Typography
        variant="caption"
        role="status"
        sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
      >
        <strong>{t('tickets:email.notDelivered')}</strong> · {detail}
      </Typography>
      <Button
        size="small"
        variant="text"
        disabled={busy}
        startIcon={<RotateCw size={12} aria-hidden="true" />}
        onClick={onRetry}
        sx={{ color: 'inherit' }}
      >
        {t('tickets:email.retry')}
      </Button>
    </Box>
  );
}
