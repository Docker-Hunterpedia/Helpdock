import type { SoundEvent } from '@helpdock/schemas';

/**
 * Plays the short bundled files of M14-25, one at a time.
 *
 * The audio element is made the first time a sound is asked for, so a person
 * with every sound off never downloads one; the browser then caches the file.
 * A browser that blocks audio (an autoplay policy, a background tab) makes
 * `play()` reject, which is answered `false` and never retried: nothing depends
 * on hearing it, and the bell shows the same news.
 */

const FILES: Record<SoundEvent, string> = {
  waitingChat: 'sounds/waiting-chat.wav',
  newConversation: 'sounds/new-conversation.wav',
  customerReply: 'sounds/customer-reply.wav',
  assignedOrMentioned: 'sounds/assigned-or-mentioned.wav',
};

/** No file is longer than this, so a stuck "playing" flag frees itself. */
export const SOUND_MAX_MS = 3_000;

export const soundUrl = (event: SoundEvent, base: string = import.meta.env.BASE_URL): string =>
  `${base.endsWith('/') ? base : `${base}/`}${FILES[event]}`;

export interface SoundPlayer {
  /**
   * Plays one sound. `false` when another is still playing (unless `interrupt`,
   * which a person's own Play button uses) or the browser refused.
   */
  play(event: SoundEvent, options?: { readonly interrupt?: boolean }): Promise<boolean>;
}

type AudioFactory = (url: string) => HTMLAudioElement;

export function createSoundPlayer(
  create: AudioFactory = (url) => new Audio(url),
  now: () => number = Date.now,
): SoundPlayer {
  const elements = new Map<SoundEvent, HTMLAudioElement>();
  let current: { readonly element: HTMLAudioElement; readonly until: number } | null = null;

  const elementFor = (event: SoundEvent): HTMLAudioElement => {
    let element = elements.get(event);
    if (element === undefined) {
      element = create(soundUrl(event));
      element.preload = 'auto';
      elements.set(event, element);
    }

    return element;
  };

  const release = (element: HTMLAudioElement): void => {
    if (current?.element === element) {
      current = null;
    }
  };

  return {
    async play(event, { interrupt = false } = {}) {
      if (current !== null && now() < current.until) {
        if (!interrupt) {
          return false;
        }
        current.element.pause();
        current = null;
      }

      let element: HTMLAudioElement | undefined;
      try {
        element = elementFor(event);
        element.currentTime = 0;
        current = { element, until: now() + SOUND_MAX_MS };
        const playing = element;
        element.addEventListener('ended', () => release(playing), { once: true });
        await element.play();

        return true;
      } catch {
        if (element !== undefined) {
          release(element);
        }

        return false;
      }
    },
  };
}

/** The one player of this tab, shared by the live sounds and the Play buttons. */
export const soundPlayer: SoundPlayer = createSoundPlayer();
