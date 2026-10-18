import {
  auditLog,
  type Db,
  INSTALL_SCOPE_BRAND_ID,
  ssoConnections,
  withSystem,
} from '@helpdock/db';
import { type JobLogger, parseJobPayloadOrFail, samlMetadataRefreshJob } from '@helpdock/jobs';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { addsCertificates, certificateFingerprint, fetchSamlMetadata } from './saml-metadata.js';
import { SamlFailure } from './saml-xml.js';
import { SSO_CONFIG_LOCK } from './sp-keys.js';

export async function refreshSamlMetadata(options: {
  db: Db;
  allowCidrs: readonly string[];
  log: JobLogger;
}) {
  // Explicit install-system read; the daily job never reads tenant data.
  const rows = await options.db
    .select()
    .from(ssoConnections)
    .where(and(eq(ssoConnections.protocol, 'saml'), eq(ssoConnections.enabled, true)));
  for (const row of rows) {
    const config = ssoConnectionConfigSchema.parse(row.config);
    if (config.protocol !== 'saml' || !config.idpMetadataUrl) continue;
    let next: string[];
    try {
      next = await fetchSamlMetadata(config, options.allowCidrs);
    } catch (error) {
      const reason = error instanceof SamlFailure ? error.code : 'sso-metadata-unavailable';
      options.log.warn({ connectionId: row.id, reason }, 'SAML metadata refresh refused');
      await withSystem(options.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
        tx.insert(auditLog).values({
          brandId: INSTALL_SCOPE_BRAND_ID,
          actorType: 'system',
          actorId: 'system',
          action: 'sso.metadata.refused',
          targetType: 'sso_connection',
          targetId: row.id,
          meta: { reason },
        }),
      );
      continue;
    }
    await withSystem(options.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SSO_CONFIG_LOCK})`);
      const [current] = await tx.select().from(ssoConnections).where(eq(ssoConnections.id, row.id));
      if (
        !current?.enabled ||
        current.updatedAt.getTime() !== row.updatedAt.getTime() ||
        JSON.stringify(current.config) !== JSON.stringify(row.config)
      )
        return;
      const fingerprints = (certs: string[]) => certs.map(certificateFingerprint).sort().join(',');
      if (fingerprints(config.idpCertificates) === fingerprints(next)) return;
      // Whoever controls the metadata URL must not be able to add a key that
      // signs assertions. Dropping one is safe; a new one waits for an admin.
      const applied = !addsCertificates(config.idpCertificates, next);
      if (applied)
        await tx
          .update(ssoConnections)
          .set({ config: { ...config, idpCertificates: next }, updatedAt: new Date() })
          .where(eq(ssoConnections.id, row.id));
      await tx.insert(auditLog).values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: 'system',
        actorId: 'system',
        action: applied ? 'sso.metadata.refreshed' : 'sso.metadata.rotation-refused',
        targetType: 'sso_connection',
        targetId: row.id,
        meta: {
          reason: applied ? 'signing-certificates-removed' : 'admin-confirmation-required',
        },
      });
    });
  }
}
export function createSamlMetadataProcessor(options: Parameters<typeof refreshSamlMetadata>[0]) {
  return (job: Pick<Job, 'name' | 'data'>) => {
    if (job.name !== samlMetadataRefreshJob.name) return undefined;
    parseJobPayloadOrFail(samlMetadataRefreshJob, job.data);
    return refreshSamlMetadata(options);
  };
}
