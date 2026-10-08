export const CSP_NONCE_META = 'helpdock:csp-nonce';

/** The per-response nonce the api places in the production admin document. */
export const readCspNonce = (): string | undefined => {
  const value = document
    .querySelector<HTMLMetaElement>(`meta[name="${CSP_NONCE_META}"]`)
    ?.content.trim();

  return value === undefined || value === '' ? undefined : value;
};
