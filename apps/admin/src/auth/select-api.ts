import type { ContactsApi } from '../contacts/api.js';
import { HttpContactsApi } from '../contacts/http-api.js';
import { MockContactsApi } from '../contacts/mock-api.js';
import { MockAttachmentUploader } from '../media/mock-uploader.js';
import type { AttachmentUploader } from '../media/upload.js';
import { HttpAttachmentUploader } from '../media/upload.js';
import type { StaffApi } from '../staff/api.js';
import { HttpStaffApi } from '../staff/http-api.js';
import { MockStaffApi } from '../staff/mock-api.js';
import type { TicketingApi } from '../ticketing/api.js';
import { HttpTicketingApi } from '../ticketing/http-api.js';
import { MockTicketingApi } from '../ticketing/mock-api.js';
import { MockBlockList } from '../ticketing/mock-block-list.js';
import type { TicketsApi } from '../tickets/api.js';
import { HttpTicketsApi } from '../tickets/http-api.js';
import { MockTicketsApi } from '../tickets/mock-api.js';
import type { AuthApi } from './api.js';
import { HttpAuthApi } from './http-api.js';
import { HttpTransport } from './http-transport.js';
import { MockAuthApi } from './mock-api.js';

export const AUTH_API_ADAPTERS = ['mock', 'http'] as const;
export type AuthApiAdapter = (typeof AUTH_API_ADAPTERS)[number];

/** The adapters the app is built from, always from the same source. */
export interface AdminApis {
  readonly auth: AuthApi;
  readonly staff: StaffApi;
  readonly contacts: ContactsApi;
  readonly ticketing: TicketingApi;
  readonly tickets: TicketsApi;
  /** M1-10's client half; the composer and the thread are its only callers. */
  readonly uploader: AttachmentUploader;
}

/**
 * `VITE_AUTH_API` wins when it names an adapter. Without it a production build
 * gets the real service and everything else gets the fixture, so shipping the
 * mock to an install takes a deliberate `VITE_AUTH_API=mock`.
 */
export function resolveAuthApiAdapter(
  configured: string | undefined,
  production: boolean,
): AuthApiAdapter {
  const named = AUTH_API_ADAPTERS.find((adapter) => adapter === configured);

  return named ?? (production ? 'http' : 'mock');
}

/**
 * Every adapter at once, sharing what they have to share: the http three share
 * one {@link HttpTransport}, so there is one access token and one refresh; the
 * mock auth and staff pair share one fixture, so an invitation sent on the
 * staff screen is the one the accept screen reads. The contacts and ticket
 * fixtures stand alone: nothing in auth reads either.
 */
export function createApis(
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): AdminApis {
  if (adapter === 'http') {
    const transport = new HttpTransport();

    return {
      auth: new HttpAuthApi(transport),
      staff: new HttpStaffApi(transport),
      contacts: new HttpContactsApi(transport),
      ticketing: new HttpTicketingApi(transport),
      tickets: new HttpTicketsApi(transport),
      uploader: new HttpAttachmentUploader(transport),
    };
  }

  const staff = new MockStaffApi();
  // The ticket fixture reads the uploader's rows, so a file attached in the
  // composer is the file the thread draws.
  const uploads = new MockAttachmentUploader();
  const blockList = new MockBlockList();
  // And the contact fixture, so a ticket filed against a contact created in
  // this session names them the way the api would.
  const contacts = new MockContactsApi();

  return {
    auth: new MockAuthApi(staff),
    staff,
    contacts,
    // One block list for both, so a sender blocked from a ticket is on the
    // Spam tab (M1-11).
    ticketing: new MockTicketingApi(blockList),
    tickets: new MockTicketsApi(uploads, Date.now(), blockList, (id) => contacts.nameOf(id)),
    uploader: uploads,
  };
}
