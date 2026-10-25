/**
 * Logos from Simple Icons (CC0-1.0, https://simpleicons.org), inlined at build
 * time; only the marks named here reach the pages. They identify the products
 * compared and the channels Helpdock connects to. A product Simple Icons does
 * not carry gets a lettermark, never a drawn imitation.
 */
import {
  siChatwoot,
  siInstagram,
  siMessenger,
  siTelegram,
  siWhatsapp,
  siZendesk,
} from 'simple-icons';

export type BrandMark = { title: string; path: string; hex: string };

const MARKS: Record<string, BrandMark> = {
  zendesk: siZendesk,
  chatwoot: siChatwoot,
  telegram: siTelegram,
  whatsapp: siWhatsapp,
  messenger: siMessenger,
  instagram: siInstagram,
};

export function brandMark(slug: string): BrandMark | undefined {
  return MARKS[slug];
}

/** The tile for a product without a mark: its first letter. */
export function lettermark(name: string): string {
  return (name.match(/\p{L}/u)?.[0] ?? '?').toUpperCase();
}
