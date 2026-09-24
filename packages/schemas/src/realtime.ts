import { z } from 'zod';

/**
 * The realtime contract of [DOMAIN-RULES
 * §7](../../../docs/planning/DOMAIN-RULES.md#7-realtime-delivery-contract), as
 * schemas rather than bare types: `apps/api` parses every inbound socket
 * message through them and validates every outbound payload before it is
 * emitted, and `apps/admin` parses what arrives. One declaration keeps the two
 * in step, exactly as `principal.ts` does for the HTTP principal.
 *
 * Sockets are notifications; REST is the truth. Nothing here is persisted and
 * nothing here is replayed; presence in particular is ephemeral (§7, §12).
 */

// ------------------------------------------------------------------- wire

/**
 * Where the server listens and what a client asks for. Both apps read these, so
 * they are here rather than declared twice: a change on one side would
 * otherwise be a silent 404 on the other.
 */
export const SOCKET_IO_PATH = '/socket.io';
export const STAFF_NAMESPACE = '/staff';
/** M4-04. Declared here so the two namespaces are read in one place. */
export const WIDGET_NAMESPACE = '/widget';

// ----------------------------------------------------------------- rooms

/**
 * A room is `<kind>:<uuid>`. Three kinds exist in v1:
 *
 * | Kind | Who may join |
 * |---|---|
 * | `brand` | anyone holding a role in that brand |
 * | `department` | anyone whose department scope in that brand covers it |
 * | `ticket` | M1 decides; the shape exists so M1 has nothing to invent |
 */
export const ROOM_KINDS = ['brand', 'department', 'ticket'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ROOM_PATTERN = new RegExp(`^(${ROOM_KINDS.join('|')}):(${UUID})$`);

export const roomSchema = z.string().regex(ROOM_PATTERN, 'must be <kind>:<uuid>');

export interface RoomRef {
  readonly kind: RoomKind;
  readonly id: string;
}

/** The kind and id of a room name, or `null` when it is not one. */
export const parseRoom = (room: string): RoomRef | null => {
  const match = ROOM_PATTERN.exec(room);
  if (match === null) {
    return null;
  }

  const [, kind = '', id = ''] = match;
  return { kind: kind as RoomKind, id };
};

export const roomOf = (kind: RoomKind, id: string): string => `${kind}:${id}`;
export const brandRoom = (brandId: string): string => roomOf('brand', brandId);
export const departmentRoom = (departmentId: string): string => roomOf('department', departmentId);
export const ticketRoom = (ticketId: string): string => roomOf('ticket', ticketId);

// -------------------------------------------------------------- presence

/** DOMAIN-RULES §12. `offline` is derived from the sockets, never sent by one. */
export const presenceStatusSchema = z.enum(['online', 'away', 'offline']);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

/** What the explicit toggle may set. Going offline is what closing the tab does. */
export const settablePresenceStatusSchema = z.enum(['online', 'away']);
export type SettablePresenceStatus = z.infer<typeof settablePresenceStatusSchema>;

export const presenceMapSchema = z.record(z.uuid(), presenceStatusSchema);
export type PresenceMap = z.infer<typeof presenceMapSchema>;

/** `GET /api/brands/:brandId/presence`: what a screen renders before any event arrives. */
export const brandPresenceSchema = z.object({
  brandId: z.uuid(),
  presence: presenceMapSchema,
  at: z.iso.datetime(),
});
export type BrandPresence = z.infer<typeof brandPresenceSchema>;

// ---------------------------------------------------------------- events

/**
 * Event names in one place, so a typo is a compile error on both sides. The
 * first group is what a socket sends; the second is what it receives.
 */
export const REALTIME_EVENTS = {
  roomJoin: 'room:join',
  roomLeave: 'room:leave',
  presenceSet: 'presence:set',
  presenceHeartbeat: 'presence:heartbeat',

  /**
   * Both directions. A client says "I have this ticket open" and the server
   * relays the same name to everybody else in `ticket:<id>`, which is what the
   * collision indicator is drawn from (M1-15; M1-09 owns the rest of §2.4).
   */
  ticketViewing: 'ticket:viewing',

  presenceChanged: 'presence:changed',
  ticketChanged: 'ticket:changed',
  ticketMessage: 'ticket:message',
  attachmentChanged: 'attachment:changed',
} as const;

export const roomJoinSchema = z.object({
  /**
   * Which brand the room belongs to. A `department:` or `ticket:` room does not
   * name its brand and the permission check has to know which membership to
   * read, so every join names one — including a `brand:` join, where it has to
   * match the room.
   */
  brandId: z.uuid(),
  room: roomSchema,
});
export type RoomJoin = z.infer<typeof roomJoinSchema>;

export const roomLeaveSchema = z.object({ room: roomSchema });
export type RoomLeave = z.infer<typeof roomLeaveSchema>;

export const presenceSetSchema = z.object({
  brandId: z.uuid(),
  status: settablePresenceStatusSchema,
});
export type PresenceSet = z.infer<typeof presenceSetSchema>;

export const presenceChangedSchema = z.object({
  userId: z.uuid(),
  brandId: z.uuid(),
  status: presenceStatusSchema,
});
export type PresenceChanged = z.infer<typeof presenceChangedSchema>;

/**
 * A ticket was created or something about it moved (M1-02). It carries ids and
 * never content: "the REST API is the source of truth; sockets are
 * notifications" (§7), so a screen re-reads the ticket rather than patching it
 * from a frame. That is also what makes an internal note impossible to leak
 * over a socket — there is no body in the payload to leak.
 *
 * `departmentId` is the department the ticket is in *now*, so a client holding
 * a `department:` room knows whether the ticket has just arrived in it or just
 * left it.
 */
export const ticketChangedSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  /**
   * The outbox event this came from. `ticket.closed` and `ticket.reopened` are
   * M1-08's: a client that only re-reads the ticket may treat all four alike,
   * but a queue that hides closed tickets, and M1-12's survey, both need to
   * know *which* change happened without diffing two reads (DOMAIN-RULES §2.2).
   */
  event: z.enum([
    'ticket.created',
    'ticket.updated',
    'ticket.closed',
    'ticket.reopened',
    // M1-11. Its own name rather than `ticket.closed`, so nothing that acts on
    // a close — a survey, an auto-responder — can mistake spam for one.
    'ticket.spam',
  ]),
});
export type TicketChanged = z.infer<typeof ticketChangedSchema>;

/**
 * A message was added to a ticket (M1-03). The envelope's `seq` is this
 * message's, which is the cursor a client compares with its own `last_seq` and
 * catches up from over REST when it finds a gap (§7).
 */
export const ticketMessageEventSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  messageId: z.uuid(),
  seq: z.int().positive(),
  kind: z.enum(['public', 'note', 'system', 'ai']),
  /** `ticket.replied` or `ticket.note_added`. */
  event: z.enum(['ticket.replied', 'ticket.note_added']),
});
export type TicketMessageEvent = z.infer<typeof ticketMessageEventSchema>;

/**
 * The media pipeline finished with an attachment (M1-10). The composer and the
 * thread render a placeholder from the moment an upload is confirmed, and this
 * is what tells them to stop: `ready` means the variants exist and a download
 * can be asked for, `rejected` and `infected` mean it never will.
 *
 * Ids and a status, like every other frame here — the URL is not in it, because
 * a presigned URL is issued to a caller who has been authorised on the parent
 * ticket *at that moment*, and a URL broadcast to a room would outlive that
 * check (DOMAIN-RULES §4.5).
 */
export const attachmentChangedSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  attachmentId: z.uuid(),
  status: z.enum(['ready', 'rejected', 'infected']),
});
export type AttachmentChanged = z.infer<typeof attachmentChangedSchema>;

/** What somebody with a ticket open is doing with it (M1-09). */
export const ticketViewingActivitySchema = z.enum(['viewing', 'replying']);
export type TicketViewingActivity = z.infer<typeof ticketViewingActivitySchema>;

/**
 * What a client sends when it has a ticket open, repeated while it stays open.
 *
 * It exists because a room is not a membership list: Socket.IO can say who is
 * in `ticket:<id>` on this replica only, and "who else is looking at this"
 * has to be true across every replica. Saying so periodically is the cheapest
 * thing that is true everywhere, and it needs no new store: whoever is in the
 * room hears it, and a name nobody has repeated inside
 * {@link TICKET_VIEWING_TTL_MS} has stopped looking.
 */
export const ticketViewingRequestSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  /**
   * M1-09: `replying` while the sender has something in the composer, so the
   * pill can say "Mona is replying" rather than only "Mona is viewing" — the
   * collision worth warning about is two people answering the same customer.
   * Defaults to `viewing`, so a client that predates it still parses.
   */
  activity: ticketViewingActivitySchema.default('viewing'),
});
export type TicketViewingRequest = z.infer<typeof ticketViewingRequestSchema>;

/** The same announcement, relayed to the rest of the room with who made it. */
export const ticketViewingSchema = ticketViewingRequestSchema.extend({
  userId: z.uuid(),
});
export type TicketViewing = z.infer<typeof ticketViewingSchema>;

/** Every server → client event and the payload it carries. M4 extends it again. */
export const REALTIME_EVENT_PAYLOADS = {
  [REALTIME_EVENTS.presenceChanged]: presenceChangedSchema,
  [REALTIME_EVENTS.ticketChanged]: ticketChangedSchema,
  [REALTIME_EVENTS.ticketMessage]: ticketMessageEventSchema,
  [REALTIME_EVENTS.attachmentChanged]: attachmentChangedSchema,
  [REALTIME_EVENTS.ticketViewing]: ticketViewingSchema,
} as const;

export type ServerEvent = keyof typeof REALTIME_EVENT_PAYLOADS;
export type ServerEventPayload<E extends ServerEvent> = z.infer<
  (typeof REALTIME_EVENT_PAYLOADS)[E]
>;

// -------------------------------------------------------------- envelope

/**
 * What goes over the wire for a server → client event.
 *
 * `seq` is the per-conversation cursor of DOMAIN-RULES §7: a client that
 * receives `seq > last_seq + 1` has missed something and catches up over REST.
 * Ephemeral events — presence, typing, queue position — are never replayed and
 * carry `null`, which is how a client tells the two apart without keeping a
 * table of event names. `at` is when the server emitted the event.
 */
export const realtimeEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    seq: z.int().nonnegative().nullable(),
    at: z.iso.datetime(),
    data,
  });

export interface RealtimeEnvelope<T> {
  readonly seq: number | null;
  readonly at: string;
  readonly data: T;
}

export const presenceChangedEnvelopeSchema = realtimeEnvelopeSchema(presenceChangedSchema);
export const attachmentChangedEnvelopeSchema = realtimeEnvelopeSchema(attachmentChangedSchema);
export const ticketChangedEnvelopeSchema = realtimeEnvelopeSchema(ticketChangedSchema);
export const ticketMessageEnvelopeSchema = realtimeEnvelopeSchema(ticketMessageEventSchema);
export const ticketViewingEnvelopeSchema = realtimeEnvelopeSchema(ticketViewingSchema);

// ------------------------------------------------------------------ acks

/**
 * Why a socket was refused, at the handshake or on an event. A code rather than
 * a sentence, because the admin renders a translated string and never an api
 * string — the rule the HTTP `AuthError` already follows.
 */
export const socketErrorCodeSchema = z.enum([
  /** No credential, or one that no longer verifies. */
  'unauthenticated',
  /** A credential that verifies, but not for this brand, room or event. */
  'forbidden',
  /** The message did not parse. */
  'invalid_payload',
  /** The session was revoked while the socket was open (DOMAIN-RULES §1.4). */
  'session_revoked',
  /** Anything the server did not expect. Carries no detail on purpose. */
  'internal',
]);
export type SocketErrorCode = z.infer<typeof socketErrorCodeSchema>;

export const socketErrorSchema = z.object({
  code: socketErrorCodeSchema,
  message: z.string(),
});
export type SocketError = z.infer<typeof socketErrorSchema>;

/** Every event that takes an acknowledgement answers with one of these. */
export const socketAckSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: socketErrorSchema }),
  ]);

export type SocketAck<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SocketError };

export const roomAckSchema = socketAckSchema(z.object({ room: roomSchema }));
export type RoomAck = z.infer<typeof roomAckSchema>;

export const presenceAckSchema = socketAckSchema(z.object({ status: presenceStatusSchema }));
export type PresenceAck = z.infer<typeof presenceAckSchema>;

export const ticketViewingAckSchema = socketAckSchema(z.object({ ticketId: z.uuid() }));
export type TicketViewingAck = z.infer<typeof ticketViewingAckSchema>;

/** `presence:heartbeat` answers with nothing but "still here". */
export const heartbeatAckSchema = socketAckSchema(z.object({ at: z.iso.datetime() }));
export type HeartbeatAck = z.infer<typeof heartbeatAckSchema>;

// --------------------------------------------------------------- timings

/** DOMAIN-RULES §12, and the numbers the client and the reaper have to agree on. */
export const PRESENCE_SOCKET_TTL_SECONDS = 60;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 25_000;
export const PRESENCE_REAPER_INTERVAL_MS = 30_000;
/** How long without a pointer, key or focus event before a client calls itself away. */
export const PRESENCE_AWAY_AFTER_MS = 5 * 60 * 1000;

/** How often a client with a ticket open says so, and how long a saying lasts. */
export const TICKET_VIEWING_INTERVAL_MS = 30_000;
/** Three intervals, so two announcements may be lost before a name is dropped. */
export const TICKET_VIEWING_TTL_MS = 90_000;
