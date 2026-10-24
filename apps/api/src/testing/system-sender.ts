import type { Settings } from '@helpdock/config';

/**
 * Gives a test install the system sender an install that took the wizard's
 * step 3 has (#369): without one, a sign-in-link or password-reset request is
 * refused with `email-unavailable` before anything is queued, so a suite that
 * exercises those requests needs these two settings to stand for a working
 * install. The values point nowhere; nothing sends, because these suites read
 * the outbox rather than running a worker.
 */
export const seedSystemSender = async (settings: Settings): Promise<void> => {
  await settings.set('smtp.host', 'smtp.example.com', { updatedBy: 'seed' });
  await settings.set('smtp.from', 'no-reply@helpdock.test', { updatedBy: 'seed' });
};
