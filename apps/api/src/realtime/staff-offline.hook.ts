/**
 * What happens when the last of someone's sockets in a brand goes away.
 *
 * DOMAIN-RULES §12 puts auto-unassign fifteen minutes after that moment,
 * configurable per department and never during closed business hours. None of
 * those three things exist before M1: there are no tickets to unassign, no
 * departments to configure and no business hours to consult.
 *
 * So the hook is declared now and does nothing. M1-07 provides its own
 * implementation under {@link ./tokens.js STAFF_OFFLINE_HOOK} and the gateway
 * does not change.
 */
export interface StaffOfflineHook {
  /**
   * @param userId the person who went offline
   * @param brandId the brand their last socket was present in
   * @param since when the server noticed, which is where M1's timer starts
   */
  onStaffOffline(userId: string, brandId: string, since: Date): void | Promise<void>;
}

export class NoopStaffOfflineHook implements StaffOfflineHook {
  onStaffOffline(): void {
    // M1-07.
  }
}
