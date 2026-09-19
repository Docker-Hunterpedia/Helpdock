---
'@helpdock/api': minor
---

Every `@Param`, `@Query` and `@Body` on a controller handler now names its Zod
schema, and `pnpm check:validation` fails the build for one that does not. A
malformed `:brandId` is refused by `brandIdParamSchema` and the response names
the field.
