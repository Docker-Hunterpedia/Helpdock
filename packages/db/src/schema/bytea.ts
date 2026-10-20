import { customType } from 'drizzle-orm/pg-core';

/**
 * A `bytea` column, read and written as a `Uint8Array`. postgres.js already
 * returns a `Buffer` (which is one) and accepts one, so the column needs no
 * conversion; it exists because drizzle-orm 0.45 has no `bytea` builder.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});
