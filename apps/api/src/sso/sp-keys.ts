import { createPrivateKey, randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto';
import type { Keyring, Settings } from '@helpdock/config';
import { auditLog, type Db, INSTALL_SCOPE_BRAND_ID, withSystem } from '@helpdock/db';
import { X509CertificateGenerator } from '@peculiar/x509';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { readSsoSetting, writeSsoSetting } from './sso-settings.js';

export interface SpKeys {
  readonly privateKey: string;
  readonly certificate: string;
}
const LOCK_KEY = 'auth:sso:sp-key-lock';
export const SSO_CONFIG_LOCK = 0x48445353;

async function generateSpKeys(): Promise<SpKeys> {
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const notBefore = new Date(Date.now() - 60000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: 'CN=Helpdock SAML SP',
    notBefore,
    notAfter,
    signingAlgorithm: algorithm,
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    privateKey: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    certificate: certificate.toString('pem'),
  };
}

function validateKeys(keys: SpKeys): SpKeys {
  const certificate = new X509Certificate(keys.certificate);
  const privateKey = createPrivateKey(keys.privateKey);
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    !certificate.checkPrivateKey(privateKey)
  ) {
    throw new Error('The SAML certificate does not match the stored private key');
  }
  return keys;
}

export async function loadSpKeys(options: {
  db: Db;
  redis: Redis;
  settings: Settings;
  keyring: Keyring;
}): Promise<SpKeys> {
  const { db, redis, settings, keyring } = options;
  const lease = randomUUID();
  const acquired = await redis.set(LOCK_KEY, lease, 'EX', 30, 'NX');
  try {
    // The DB lock remains authoritative even if the Redis lease expires or Redis restarts.
    return await withSystem(db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SSO_CONFIG_LOCK})`);
      const privateKey = await readSsoSetting(tx, settings, keyring, 'sso.spPrivateKey');
      const certificate = await readSsoSetting(tx, settings, keyring, 'sso.spCertificate');
      if (privateKey !== '' || certificate !== '') return validateKeys({ privateKey, certificate });
      if (
        settings.isLockedByEnv('sso.spPrivateKey') ||
        settings.isLockedByEnv('sso.spCertificate')
      ) {
        throw new Error(
          'Environment-pinned SAML keys must contain a matching private key and certificate',
        );
      }
      const generated = await generateSpKeys();
      await writeSsoSetting(tx, keyring, {
        key: 'sso.spPrivateKey',
        value: generated.privateKey,
        actorId: 'system',
      });
      await writeSsoSetting(tx, keyring, {
        key: 'sso.spCertificate',
        value: generated.certificate,
        actorId: 'system',
      });
      await tx.insert(auditLog).values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: 'system',
        actorId: 'system',
        action: 'sso.sp.generated',
        targetType: 'sso',
        targetId: 'sp',
        meta: { keys: ['sso.spPrivateKey', 'sso.spCertificate'] },
      });
      return generated;
    });
  } finally {
    if (acquired !== null)
      await redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        LOCK_KEY,
        lease,
      );
  }
}
