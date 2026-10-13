import type { MetaAccount, MetaPlatform } from '@helpdock/schemas';
import { Camera, type LucideIcon, MessagesSquare, Phone } from 'lucide-react';

/**
 * The icon of each platform, DESIGN §5: generic shapes for what the channel is
 * — a number, a Page conversation, a photo account — and never a brand mark.
 */
export const PLATFORM_ICONS: Readonly<Record<MetaPlatform, LucideIcon>> = {
  whatsapp: Phone,
  messenger: MessagesSquare,
  instagram: Camera,
};

/** What the person told the dialog apart by: the number, the Page's name, the `@handle`. */
export const accountLabel = (
  account: Pick<MetaAccount, 'platform' | 'displayPhone' | 'username' | 'displayName'>,
): string => {
  switch (account.platform) {
    case 'whatsapp':
      return account.displayPhone ?? account.displayName;
    case 'messenger':
      return account.displayName;
    case 'instagram':
      return account.username === null ? account.displayName : `@${account.username}`;
  }
};

/** The account's other name, under its label in the table: WhatsApp's verified name, else its kind. */
export const accountSublabel = (
  account: Pick<MetaAccount, 'platform' | 'displayName'>,
  kind: string,
): string => (account.platform === 'whatsapp' ? account.displayName : kind);
