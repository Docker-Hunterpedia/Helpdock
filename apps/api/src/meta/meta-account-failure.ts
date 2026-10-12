import { type Db, withSystem } from '@helpdock/db';
import type { MetaRepository } from './meta.repository.js';

/**
 * What a job that failed against Graph tells the account's row, in a
 * transaction of its own: the job has no transaction open while it waits on
 * Meta, and the throw that follows ends its attempt, so the write cannot ride
 * on one. A dead token moves the account to `token_expired`; any other
 * refusal is `last_error` and nothing more. Never the token.
 */
export interface MetaAccountFailure {
  readonly kind: 'token_dead' | 'other';
  readonly detail: string;
}

export type AccountFailureRecorder = (
  brandId: string,
  accountId: string,
  failure: MetaAccountFailure,
) => Promise<void>;

export const accountFailureRecorder =
  (
    db: Db,
    repository: Pick<MetaRepository, 'markError' | 'markTokenDead'>,
    now: () => Date = () => new Date(),
  ): AccountFailureRecorder =>
  (brandId, accountId, failure) =>
    withSystem(db, brandId, async (tx) =>
      failure.kind === 'token_dead'
        ? repository.markTokenDead(tx, accountId, failure.detail, now())
        : repository.markError(tx, accountId, failure.detail, now()),
    );
