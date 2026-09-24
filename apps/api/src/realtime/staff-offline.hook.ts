/**
 * What happens when the last of someone's sockets in a brand goes away.
 *
 * DOMAIN-RULES §12 puts auto-unassign fifteen minutes after that moment,
 * configurable per department and never during closed business hours. M0-13
 * declared the hook; M1-07's `OutboxStaffOfflineHook`
 * (`assignment/staff-offline.hook.ts`) is what `RealtimeModule` provides under
 * {@link ./tokens.js STAFF_OFFLINE_HOOK}, and the gateway did not change.
 */
export interface StaffOfflineHook {
  /**
   * @param userId the person who went offline
   * @param brandId the brand their last socket was present in
   * @param since when the server noticed, which is where M1's timer starts
   */
  onStaffOffline(userId: string, brandId: string, since: Date): void | Promise<void>;
}

/** For the unit tests of the gateway, which are about sockets and not about tickets. */
export class NoopStaffOfflineHook implements StaffOfflineHook {
  onStaffOffline(): void {
    // Nothing: the gateway's tests assert on the call, not on its effect.
  }
}
