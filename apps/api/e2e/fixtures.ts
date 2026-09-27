/** What `web-form-server.ts` serves and `web-form.spec.ts` visits. */
export const PORT = Number(process.env.HD_WEB_FORM_E2E_PORT ?? 5290);
export const OPEN_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
export const CLOSED_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';
/** The reference every accepted submission gets from the in-memory brand. */
export const REFERENCE = 'HD-1042';
