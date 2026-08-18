/**
 * Span of control for a production superintendent.
 *
 * Ten houses is where a super stops being able to walk every one of them in a
 * week; past fifteen the schedule stops being run and starts being reported.
 * The assignment picker has to show this — a list of 300 names with no capacity
 * signal is how someone quietly ends up with eighteen.
 */
export const SUPERINTENDENT_LOAD_WARNING = 10
export const SUPERINTENDENT_LOAD_LIMIT = 15

export type SuperintendentLoad = "clear" | "stretched" | "over"

export function superintendentLoad(activeHouses: number): SuperintendentLoad {
  if (activeHouses >= SUPERINTENDENT_LOAD_LIMIT) return "over"
  if (activeHouses >= SUPERINTENDENT_LOAD_WARNING) return "stretched"
  return "clear"
}
