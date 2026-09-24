import type { ContactIdentity, ContactIdentityKind } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { Code, Mail, MessageCircle, Phone, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { identityLabel, initialsOf } from './format.js';

/**
 * The three small pieces both contact screens draw: the avatar, the channel
 * icons and the "verified / unverified" caption beside an identifier.
 *
 * The verification state is said **in words**, never by colour alone
 * (DESIGN §10): a contact with two addresses, one proven and one typed, has to
 * be readable by somebody who cannot tell green from grey.
 */

/** DESIGN §5: one icon per channel, from the set the whole product uses. */
export const CHANNEL_ICONS = {
  email: Mail,
  phone: Phone,
  telegram: Send,
  visitor: MessageCircle,
  external: Code,
} as const;

export function ChannelIcons({
  channels,
}: {
  readonly channels: readonly ContactIdentityKind[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {channels.map((kind) => {
        const Icon = CHANNEL_ICONS[kind];

        return (
          <Icon
            key={kind}
            size={14}
            color={tokens['text.secondary']}
            aria-label={t(`contacts:channel.${kind}`)}
          />
        );
      })}
    </Box>
  );
}

/**
 * DESIGN §6.2 Avatar: initials in a circle, and a dashed ring when nobody has
 * told us who this is — the artboard's anonymous-visitor row.
 */
export function ContactAvatar({
  name,
  anonymous = false,
  size = 28,
}: {
  readonly name: string;
  readonly anonymous?: boolean;
  readonly size?: number;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      aria-hidden="true"
      sx={{
        inlineSize: size,
        blockSize: size,
        borderRadius: '999px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: size >= 36 ? 14 : 12,
        fontWeight: 600,
        color: tokens['text.secondary'],
        backgroundColor: anonymous ? 'transparent' : tokens['bg.muted'],
        border: anonymous
          ? `1px dashed ${tokens['border.strong']}`
          : `1px solid ${tokens['border.default']}`,
      }}
    >
      {initialsOf(name)}
    </Box>
  );
}

/** An identifier with its state in words: `mona@example.com verified`. */
export function IdentityLine({
  identity,
  component = 'span',
}: {
  readonly identity: ContactIdentity;
  readonly component?: 'span' | 'div';
}): ReactNode {
  const t = useT();

  return (
    <Typography variant="caption" component={component} sx={{ color: 'text.secondary' }}>
      {/* DESIGN §7: an address, a number or an id inside Arabic prose is
          isolated so it still reads left to right. */}
      <bdi>{identityLabel(identity)}</bdi>{' '}
      {identity.kind === 'visitor'
        ? t('contacts:identity.linked')
        : identity.verified
          ? t('contacts:identity.verified')
          : t('contacts:identity.unverified')}
    </Typography>
  );
}
