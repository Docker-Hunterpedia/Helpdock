import { Box, Button, ButtonBase } from '@mui/material';
import { CornerDownRight, Reply } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The thread's two M14-31 controls (`Admin/Ticket-ListToggle-ReplyTo`): the
 * Reply button on a customer's email, and the "In reply to …" line above an
 * agent's reply that answered one.
 */

/** The element id a message can be scrolled to and focused by. */
export const messageAnchor = (messageId: string): string => `message-${messageId}`;

/** Scrolls to a message of the thread and moves focus onto it. */
export const jumpToMessage = (messageId: string): void => {
  const element = document.getElementById(messageAnchor(messageId));
  if (element === null) {
    return;
  }
  element.scrollIntoView?.({ block: 'center' });
  element.focus({ preventScroll: true });
};

const mirrored = (locale: string): { transform: string | undefined } => ({
  transform: locale === 'ar' ? 'scaleX(-1)' : undefined,
});

/** 24 px high with a 32 px hit area; named for whose message it answers. */
export function ReplyButton({
  name,
  pressed,
  onPress,
}: {
  readonly name: string;
  /** The composer's strip names this message. */
  readonly pressed: boolean;
  onPress(): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();

  return (
    <Box component="span" sx={{ display: 'inline-flex', marginBlock: '-4px', flexShrink: 0 }}>
      <Button
        size="small"
        variant="text"
        aria-label={t('tickets:replyTo.buttonLabel', { name })}
        aria-pressed={pressed}
        onClick={onPress}
        startIcon={<Reply size={14} aria-hidden="true" style={mirrored(locale)} />}
        sx={{
          height: 24,
          minWidth: 0,
          paddingInline: 2,
          fontSize: 12,
          fontWeight: 500,
          color: tokens['text.primary'],
          // A 24 px button with a 32 px target, as the artboard says.
          position: 'relative',
          '&::after': { content: '""', position: 'absolute', inset: '-4px -2px' },
        }}
      >
        {t('tickets:replyTo.button')}
      </Button>
    </Box>
  );
}

/** Above the body of an agent's reply that answered one email; presses to that email. */
export function InReplyToLink({
  name,
  time,
  targetId,
}: {
  /** Null when the email is not in this thread (purged, or not loaded). */
  readonly name: string | null;
  readonly time: string | null;
  readonly targetId: string | null;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const found = name !== null && time !== null && targetId !== null;
  const icon = <CornerDownRight size={12} aria-hidden="true" style={mirrored(locale)} />;

  if (!found) {
    return (
      <Box
        component="p"
        sx={{
          margin: 0,
          marginBlockEnd: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          fontSize: 12,
          color: tokens['text.secondary'],
        }}
      >
        {icon}
        {t('tickets:replyTo.inReplyToEarlier')}
      </Box>
    );
  }

  return (
    <ButtonBase
      aria-label={t('tickets:replyTo.inReplyToLabel', { name, time })}
      onClick={() => {
        jumpToMessage(targetId);
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        marginBlockEnd: 2,
        fontSize: 12,
        color: tokens['text.link'],
        textAlign: 'start',
        borderRadius: '4px',
      }}
    >
      {icon}
      <span dir="auto">{t('tickets:replyTo.inReplyTo', { name, time })}</span>
    </ButtonBase>
  );
}
