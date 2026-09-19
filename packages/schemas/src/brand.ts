import { z } from 'zod';

/** The interface and content languages Helpdock ships with (REQUIREMENTS §3). */
export const localeSchema = z.enum(['en', 'ar']);

/** `deleting` is the 30-day grace window of DOMAIN-RULES §11. */
export const brandStatusSchema = z.enum(['active', 'deleting', 'deleted']);

/**
 * A brand as the API returns it. Deliberately narrower than the row: nothing
 * here may leak a column a later milestone adds, because the output schema is
 * what the response is parsed through (ARCHITECTURE §6).
 */
export const brandSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  defaultLocale: localeSchema,
  timezone: z.string(),
  status: brandStatusSchema,
});
export type Brand = z.infer<typeof brandSchema>;

export const brandListSchema = z.object({
  brands: z.array(brandSchema),
});
export type BrandList = z.infer<typeof brandListSchema>;

/** The `:brandId` path parameter, which is also what the permission guard scopes on. */
export const brandIdParamSchema = z.object({
  brandId: z.uuid(),
});
export type BrandIdParam = z.infer<typeof brandIdParamSchema>;
