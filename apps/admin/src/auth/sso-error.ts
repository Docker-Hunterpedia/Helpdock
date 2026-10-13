const SSO_ERROR_KEYS = {
  'sso-email-unverified': 'auth:sso.errors.sso-email-unverified',
  'sso-no-access': 'auth:sso.errors.sso-no-access',
  'sso-connection-disabled': 'auth:sso.errors.sso-connection-disabled',
  'sso-required': 'auth:sso.errors.sso-required',
  'sso-invalid-response': 'auth:sso.errors.sso-invalid-response',
} as const;

export function ssoErrorKey(code: string | null) {
  return code !== null && Object.hasOwn(SSO_ERROR_KEYS, code)
    ? SSO_ERROR_KEYS[code as keyof typeof SSO_ERROR_KEYS]
    : undefined;
}
