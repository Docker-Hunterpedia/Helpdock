import { loadEnv } from '@helpdock/config';
import { createDb, ssoConnections, userSsoIdentities, uuidv7 } from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import { z } from 'zod';

// Browser-fixture CLI only; certificates and principals are disposable.
const env = loadEnv();
if (env.NODE_ENV !== 'test') throw new Error('SAML fixture requires NODE_ENV=test');
const userId = z.uuid().parse(process.argv[2]);
const certificate = z.string().min(1).max(16000).parse(process.argv[3]);
const connectionId = uuidv7();
const handle = createDb({ url: env.DATABASE_URL });
try {
  await handle.db.transaction(async (tx) => {
    await tx.insert(ssoConnections).values({
      id: connectionId,
      name: 'Browser SAML',
      protocol: 'saml',
      enabled: true,
      createdBy: userId,
      groupAttribute: 'groups',
      emailDomains: ['example.com'],
      config: ssoConnectionConfigSchema.parse({
        protocol: 'saml',
        idpEntityId: 'http://127.0.0.1:8443',
        idpSsoUrl: 'http://127.0.0.1:8443/sso',
        idpCertificates: [certificate],
        emailAttribute: 'email',
        nameAttribute: 'name',
      }),
    });
    await tx
      .insert(userSsoIdentities)
      .values({ userId, connectionId, subject: 'staff-1', emailAtLink: 'ada@example.com' });
  });
  process.stdout.write(JSON.stringify({ connectionId }));
} finally {
  await handle.close();
}
