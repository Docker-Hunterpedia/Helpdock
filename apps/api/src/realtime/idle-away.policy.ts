/**
 * M14-18, DOMAIN-RULES §12: whom the presence sweep may mark away for being
 * idle, and after how long.
 *
 * Presence knows sockets and clocks; which department an agent works and what
 * it asks for are the assignment module's. This is the seam between them, so
 * the realtime module never reads a department.
 */
export interface IdleAwayPolicy {
  /**
   * Minutes of silence after which each person is marked away, for the people
   * this brand's departments ask it of. Anyone absent from the map is never
   * marked away for being idle.
   */
  limitsFor(brandId: string): Promise<ReadonlyMap<string, number>>;
}

/** For the unit tests of the service, which are about clocks and not about departments. */
export class NoIdleAwayPolicy implements IdleAwayPolicy {
  limitsFor(): Promise<ReadonlyMap<string, number>> {
    return Promise.resolve(new Map());
  }
}
