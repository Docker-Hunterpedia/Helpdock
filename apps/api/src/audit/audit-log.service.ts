import { type AuditLogEntry, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import {
  AUDIT_INSTALL_BRAND,
  type AuditLogPage,
  type AuditLogQuery,
  type AuditRecord,
} from '@helpdock/schemas';
import { BadRequestException } from '@nestjs/common';
import { getTx } from '../context/request-context.js';
import { widenInstallScope } from '../tenant/install-scope.js';
import { decodeAuditCursor, encodeAuditCursor, InvalidAuditCursorError } from './audit-cursor.js';
import { auditDiffOf } from './audit-diff.js';
import type { AuditLogRepository } from './audit-log.repository.js';

/**
 * The admin audit log viewer (M3-08, REQUIREMENTS §4.10): every brand's rows
 * and the install's own, newest first, filtered and paged, read-only.
 *
 * The route runs in install scope, so the tenant interceptor has already
 * written this read's own `install.scope.access` row — "opening this page
 * writes its own install.scope.access row" (artboard `AdminAuditLog`). The
 * transaction is then widened to every brand, because the page is install-wide
 * and a brand's rows are otherwise invisible to the sentinel.
 *
 * Nothing stored in `meta` reaches the response as it is stored: it goes
 * through `auditDiffOf`, which redacts every secret by name.
 */
export class AuditLogService {
  readonly #repository: AuditLogRepository;

  constructor(repository: AuditLogRepository) {
    this.#repository = repository;
  }

  async page(query: AuditLogQuery): Promise<AuditLogPage> {
    const tx = getTx();
    const brandList = await this.#repository.brands(tx);
    await widenInstallScope(
      tx,
      brandList.map((brand) => brand.id),
    );

    const rows = await this.#repository.list(tx, {
      actor: query.actor,
      action: query.action,
      targetType: query.targetType,
      brandId: brandFilterOf(query.brand),
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      before: cursorOf(query.cursor),
      // One more than a page, to know whether there is another without counting.
      limit: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const names = await this.#repository.staffNames(
      tx,
      page.filter((row) => row.actorType === 'staff').map((row) => row.actorId),
    );
    const brandNames = new Map(brandList.map((brand) => [brand.id, brand.name]));
    const last = page.at(-1);

    return {
      entries: page.map((row) => toRecord(row, names, brandNames)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeAuditCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null,
      brands: brandList,
    };
  }
}

const brandFilterOf = (brand: string | undefined): string | undefined =>
  brand === AUDIT_INSTALL_BRAND ? INSTALL_SCOPE_BRAND_ID : brand;

const cursorOf = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    return decodeAuditCursor(cursor);
  } catch (error) {
    if (error instanceof InvalidAuditCursorError) {
      throw new BadRequestException(error.message);
    }
    /* c8 ignore next 2 -- decoding throws nothing else. */
    throw error;
  }
};

export const toRecord = (
  row: AuditLogEntry,
  names: ReadonlyMap<string, string>,
  brandNames: ReadonlyMap<string, string>,
): AuditRecord => {
  const install = row.brandId === INSTALL_SCOPE_BRAND_ID;
  // M0's install-scope rows kept the request id in `meta`, before it had a column.
  const { requestId: metaRequestId, ...meta } = row.meta;

  return {
    id: row.id,
    brandId: install ? null : row.brandId,
    brandName: install ? null : (brandNames.get(row.brandId) ?? null),
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorType === 'staff' ? (names.get(row.actorId) ?? null) : null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ip: row.ip,
    requestId: row.requestId ?? (typeof metaRequestId === 'string' ? metaRequestId : null),
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    ...auditDiffOf(meta),
  };
};
