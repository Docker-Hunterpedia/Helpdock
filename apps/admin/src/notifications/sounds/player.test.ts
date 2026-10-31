import type { SoundEvent } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { createSoundPlayer, SOUND_MAX_MS, soundUrl } from './player.js';

class FakeAudio {
  static created: string[] = [];
  readonly played: string[] = [];
  currentTime = 0;
  preload = '';
  paused = false;
  readonly #listeners = new Set<() => void>();
  readonly src: string;

  constructor(
    src: string,
    private readonly refuse: boolean,
  ) {
    this.src = src;
    FakeAudio.created.push(src);
  }

  addEventListener(_type: 'ended', listener: () => void): void {
    this.#listeners.add(listener);
  }

  pause(): void {
    this.paused = true;
  }

  async play(): Promise<void> {
    if (this.refuse) {
      throw new DOMException('blocked', 'NotAllowedError');
    }
    this.played.push(this.src);
  }

  end(): void {
    for (const listener of this.#listeners) listener();
  }
}

const setup = ({ refuse = false } = {}) => {
  FakeAudio.created = [];
  const elements: FakeAudio[] = [];
  let clock = 0;
  const player = createSoundPlayer(
    (url) => {
      const element = new FakeAudio(url, refuse);
      elements.push(element);

      return element as unknown as HTMLAudioElement;
    },
    () => clock,
  );

  return { player, elements, advance: (ms: number) => (clock += ms) };
};

describe('the sound player', () => {
  it('maps every event to its own bundled file under the app base', () => {
    const events: SoundEvent[] = [
      'waitingChat',
      'newConversation',
      'customerReply',
      'assignedOrMentioned',
    ];

    expect(events.map((event) => soundUrl(event, '/'))).toEqual([
      '/sounds/waiting-chat.wav',
      '/sounds/new-conversation.wav',
      '/sounds/customer-reply.wav',
      '/sounds/assigned-or-mentioned.wav',
    ]);
    expect(soundUrl('waitingChat', '/admin')).toBe('/admin/sounds/waiting-chat.wav');
  });

  it('loads a file only when it is first asked for, and reuses the element', async () => {
    const { player } = setup();
    expect(FakeAudio.created).toEqual([]);

    expect(await player.play('customerReply')).toBe(true);
    await player.play('customerReply');

    expect(FakeAudio.created).toHaveLength(1);
  });

  it('plays one sound at a time, and again once it has ended', async () => {
    const { player, elements } = setup();

    expect(await player.play('waitingChat')).toBe(true);
    expect(await player.play('newConversation')).toBe(false);
    expect(elements).toHaveLength(1);

    elements[0]?.end();
    expect(await player.play('newConversation')).toBe(true);
  });

  it('frees itself after the longest a sound can take, if ended never arrives', async () => {
    const { player, advance } = setup();
    await player.play('waitingChat');

    advance(SOUND_MAX_MS);

    expect(await player.play('newConversation')).toBe(true);
  });

  it('lets a person’s own Play button cut in, stopping what was playing', async () => {
    const { player, elements } = setup();
    await player.play('waitingChat');

    expect(await player.play('customerReply', { interrupt: true })).toBe(true);
    expect(elements[0]?.paused).toBe(true);
  });

  it('answers false when the browser refuses, and is not stuck busy afterwards', async () => {
    const { player } = setup({ refuse: true });

    expect(await player.play('waitingChat')).toBe(false);
    expect(await player.play('waitingChat')).toBe(false);
  });
});
