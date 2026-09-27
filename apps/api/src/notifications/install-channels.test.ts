import type { Settings } from '@helpdock/config';
import { describe, expect, it } from 'vitest';
import { InstallChannels } from './install-channels.js';

const SMTP = {
  'smtp.host': 'mailpit',
  'smtp.port': 1025,
  'smtp.tls': 'none',
  'smtp.user': '',
  'smtp.password': '',
  'smtp.from': 'desk@example.com',
  'smtp.fromName': '',
  'push.vapidPublicKey': '',
  'push.vapidPrivateKey': '',
} as const;

const settingsWith = (values: Record<string, unknown>): Pick<Settings, 'get'> => ({
  get: (async (key: string) => values[key]) as Settings['get'],
});

describe('InstallChannels', () => {
  it('has no system sender until SMTP has a host and a From address', async () => {
    expect(
      await new InstallChannels(settingsWith({ ...SMTP, 'smtp.host': '' })).systemSender(),
    ).toBe(null);
    expect(
      await new InstallChannels(settingsWith({ ...SMTP, 'smtp.from': '' })).systemSender(),
    ).toBe(null);
  });

  it('builds a sender from the install SMTP settings', async () => {
    const sender = await new InstallChannels(settingsWith(SMTP)).systemSender();

    expect(sender).not.toBeNull();
    expect(typeof sender?.send).toBe('function');
  });

  it('closes its transport after a send, whether or not the send worked', async () => {
    const sender = await new InstallChannels(
      settingsWith({ ...SMTP, 'smtp.host': '127.0.0.1', 'smtp.port': 1 }),
    ).systemSender();

    await expect(
      sender?.send({
        to: { address: 'lina@example.com' },
        subject: 'x',
        text: 'x',
        html: 'x',
        locale: 'en',
      }),
    ).rejects.toThrow();
  });

  it('reports push as set up only when both halves of the VAPID pair exist', async () => {
    const half = new InstallChannels(settingsWith({ ...SMTP, 'push.vapidPublicKey': 'pub' }));
    const whole = new InstallChannels(
      settingsWith({ ...SMTP, 'push.vapidPublicKey': 'pub', 'push.vapidPrivateKey': 'priv' }),
    );

    expect(await half.vapidKeys()).toBeNull();
    expect(await half.vapidPublicKey()).toBeNull();
    expect(await whole.vapidKeys()).toEqual({ publicKey: 'pub', privateKey: 'priv' });
    expect(await whole.vapidPublicKey()).toBe('pub');
  });
});
