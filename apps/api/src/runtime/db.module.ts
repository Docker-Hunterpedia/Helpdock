import type { Db } from '@helpdock/db';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DB } from './tokens.js';

/**
 * The Drizzle client, which boot has already opened and proved safe with
 * `assertRuntimeRoleIsSafe` (DOMAIN-RULES §1.5). Nothing here wraps a query:
 * queries run through the transaction the
 * {@link ../tenant/tenant.interceptor.js TenantInterceptor} opened, reached with
 * `getTx()`.
 *
 * The pool is closed by whoever opened it, in `bootstrap.ts`, so that the order
 * of shutdown is one thing in one place.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class DbModule {
  static forRoot(db: Db): DynamicModule {
    return {
      module: DbModule,
      providers: [{ provide: DB, useValue: db }],
      exports: [DB],
    };
  }
}
