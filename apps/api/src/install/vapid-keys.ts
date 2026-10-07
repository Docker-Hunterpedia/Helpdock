import type { Settings } from '@helpdock/config';
import webpush from 'web-push';
import type { VapidKeys } from '../notifications/push.js';

export type VapidKeyGenerator = () => VapidKeys;

export const generateVapidKeys: VapidKeyGenerator = () => webpush.generateVAPIDKeys();

/**
 * ADR 0002: "A single VAPID key pair is generated once per install, during the
 * first-run wizard". An install that already has a pair, or whose operator
 * pinned either half with `HD_PUSH_VAPID_*`, keeps what it has: replacing a
 * pair invalidates every browser subscribed to it.
 *
 * Answers whether it wrote a pair.
 */
export const ensureVapidKeys = async (
  settings: Pick<Settings, 'get' | 'set' | 'isLockedByEnv'>,
  generate: VapidKeyGenerator,
  updatedBy: string,
): Promise<boolean> => {
  if (
    settings.isLockedByEnv('push.vapidPublicKey') ||
    settings.isLockedByEnv('push.vapidPrivateKey')
  ) {
    return false;
  }

  const [publicKey, privateKey] = await Promise.all([
    settings.get('push.vapidPublicKey'),
    settings.get('push.vapidPrivateKey'),
  ]);
  if (publicKey !== '' && privateKey !== '') {
    return false;
  }

  const pair = generate();
  // Private half first: a crash between the two writes leaves no public key to
  // subscribe with, rather than one nothing can sign for.
  await settings.set('push.vapidPrivateKey', pair.privateKey, { updatedBy });
  await settings.set('push.vapidPublicKey', pair.publicKey, { updatedBy });
  return true;
};
