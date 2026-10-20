import { z } from 'zod';

/**
 * M14-01: a person's keyboard settings. They are stored on the account rather
 * than in the browser because the switch below is an accessibility setting
 * (WCAG 2.1.4) and has to follow the person to any browser they sign in on.
 *
 * `singleKeyShortcuts` off turns off every shortcut that is a key without a
 * modifier (`j`, `r`, `?`, `g` then `i`); `⌘`/`Ctrl` shortcuts keep working.
 * On by default (owner decision D-32).
 */
export const keyboardPreferencesSchema = z.object({
  singleKeyShortcuts: z.boolean(),
});
export type KeyboardPreferences = z.infer<typeof keyboardPreferencesSchema>;
