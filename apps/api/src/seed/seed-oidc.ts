import { createKeyring, encryptSecret, loadEnv } from '@helpdock/config';
import { createDb, ssoConnections, userSsoIdentities, uuidv7 } from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import { z } from 'zod';

// Browser-fixture CLI only. Never creates provider bindings in a real install.
const env = loadEnv();
if (env.NODE_ENV !== 'test') throw new Error('OIDC fixture requires NODE_ENV=test');
const userId = z.uuid().parse(process.argv[2]);
const connectionId = uuidv7();
const handle = createDb({ url: env.DATABASE_URL });
try {
  await handle.db.transaction(async (tx) => {
    await tx.insert(ssoConnections).values({
      id: connectionId,
      name: 'Browser OIDC',
      protocol: 'oidc',
      enabled: true,
      createdBy: userId,
      groupAttribute: 'groups',
      config: ssoConnectionConfigSchema.parse({
        protocol: 'oidc',
        issuer: 'http://127.0.0.1:8080',
        clientId: 'helpdock',
      }),
      secretEncrypted: encryptSecret('test-secret', createKeyring(env)),
    });
    await tx
      .insert(userSsoIdentities)
      .values({ userId, connectionId, subject: 'staff-1', emailAtLink: 'ada@example.com' });
  });
  process.stdout.write(JSON.stringify({ connectionId }));
} finally {
  await handle.close();
}
