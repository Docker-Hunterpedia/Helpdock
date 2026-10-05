/** What `web-form-server.ts` serves and `web-form.spec.ts` visits. */
export const PORT = Number(process.env.HD_WEB_FORM_E2E_PORT ?? 5290);
export const OPEN_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
export const CLOSED_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';
/** The reference every accepted submission gets from the in-memory brand. */
export const REFERENCE = 'HD-1042';

/** What `help-center-server.ts` serves and `help-center.spec.ts` visits (M5-03). */
export const HELP_CENTER_PORT = Number(process.env.HD_HELP_CENTER_E2E_PORT ?? 5291);
export const HELP_CENTER_URL = `http://127.0.0.1:${String(HELP_CENTER_PORT)}`;
/** The same server's internal-only twin, for the wall every visitor meets there (M9-04). */
export const HELP_CENTER_WALL_PORT = HELP_CENTER_PORT + 100;
export const HELP_CENTER_WALL_URL = `http://127.0.0.1:${String(HELP_CENTER_WALL_PORT)}`;
