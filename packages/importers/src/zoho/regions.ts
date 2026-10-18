export { type ZohoCredentials, zohoCredentialsSchema } from '@helpdock/schemas';

// Desk API Endpoints by Data Center and Accounts Server Domains, checked 2026-10-17.
export const ZOHO_REGIONS = {
  us: { accounts: 'https://accounts.zoho.com', desk: 'https://desk.zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', desk: 'https://desk.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', desk: 'https://desk.zoho.in' },
  au: { accounts: 'https://accounts.zoho.com.au', desk: 'https://desk.zoho.com.au' },
  ca: { accounts: 'https://accounts.zohocloud.ca', desk: 'https://desk.zohocloud.ca' },
  jp: { accounts: 'https://accounts.zoho.jp', desk: 'https://desk.zoho.jp' },
  sa: { accounts: 'https://accounts.zoho.sa', desk: 'https://desk.zoho.sa' },
  cn: { accounts: 'https://accounts.zoho.com.cn', desk: 'https://desk.zoho.com.cn' },
  sg: { accounts: 'https://accounts.zoho.sg', desk: 'https://desk.zoho.sg' },
  ae: { accounts: 'https://accounts.zoho.ae', desk: 'https://desk.zoho.ae' },
} as const;
