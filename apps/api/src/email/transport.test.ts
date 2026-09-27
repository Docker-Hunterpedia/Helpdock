import { SmtpEmailSender } from '@helpdock/channels';
import { createKeyring, encryptSecret, type Settings } from '@helpdock/config';
import { describe, expect, it } from 'vitest';
import { settingsRow } from '../testing/email-fixtures.js';
import { brandSmtpServer, SettingsInstallSmtp, smtpTransportFactory } from './transport.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') });

const settingsWith = (values: Record<string, unknown>): Settings =>
  ({ get: async (key: string) => values[key] }) as unknown as Settings;

describe('brandSmtpServer', () => {
  it('is undefined for a brand without a server of its own', () => {
    expect(brandSmtpServer(undefined, keyring)).toBeUndefined();
    expect(brandSmtpServer(settingsRow(), keyring)).toBeUndefined();
  });

  it('decrypts the stored password, and reads none as empty', () => {
    const row = settingsRow({ smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: 'starttls' });

    expect(
      brandSmtpServer({ ...row, smtpPassword: encryptSecret('s3cret', keyring) }, keyring),
    ).toMatchObject({ host: 'smtp.example.com', password: 's3cret', user: '' });
    expect(brandSmtpServer(row, keyring)?.password).toBe('');
  });
});

describe('SettingsInstallSmtp', () => {
  it('is undefined while the wizard left SMTP unconfigured', async () => {
    await expect(
      new SettingsInstallSmtp(settingsWith({ 'smtp.host': '' })).read(),
    ).resolves.toBeUndefined();
  });

  it('has no sender when no From address was saved', async () => {
    const read = await new SettingsInstallSmtp(
      settingsWith({
        'smtp.host': 'relay',
        'smtp.port': 25,
        'smtp.tls': 'none',
        'smtp.user': '',
        'smtp.password': '',
        'smtp.from': '',
      }),
    ).read();

    expect(read?.server.host).toBe('relay');
    expect(read?.from).toBeUndefined();
  });
});

describe('smtpTransportFactory', () => {
  it('builds a Nodemailer transport that uses the address when the name is empty', () => {
    const transport = smtpTransportFactory(
      { host: 'localhost', port: 1, tls: 'none', user: '', password: '' },
      { address: 'support@example.com', name: '' },
    );

    expect(transport).toBeInstanceOf(SmtpEmailSender);
    transport.close();
  });
});
