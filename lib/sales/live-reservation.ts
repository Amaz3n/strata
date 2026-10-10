/** Reservation statuses that still own a lot. */
export const LIVE_RESERVATION_STATUSES = ["hold", "reserved", "converted"]

/**
 * A hold past its expiry no longer blocks a lot, whether or not the sweep has
 * run yet. Reads decide liveness from the data; only the scheduled sweep writes
 * the `expired` status. PostgREST `.or()` filter for rows that are still live.
 */
export function liveReservationOrFilter(now: Date = new Date()) {
  return `status.neq.hold,expires_at.is.null,expires_at.gt.${now.toISOString()}`
}
