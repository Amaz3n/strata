/**
 * Span of control for a production superintendent.
 *
 * Ten houses is where a super stops being able to walk every one of them in a
 * week; past fifteen the schedule stops being run and starts being reported.
 * These are the defaults; an org sets its own, and a person can have theirs
 * (`superintendent_capacity`, resolved in SQL by `superintendent_house_limits`,
 * which falls back to the same ten and fifteen).
 *
 * `max` is a limit, not a warning: the house after it is assigned only with a
 * reason, by someone who can release starts.
 */
export const SUPERINTENDENT_LOAD_WARNING = 10
export const SUPERINTENDENT_LOAD_LIMIT = 15

export interface SuperintendentLimits {
  warn: number
  max: number
}

export const DEFAULT_SUPERINTENDENT_LIMITS: SuperintendentLimits = { warn: SUPERINTENDENT_LOAD_WARNING, max: SUPERINTENDENT_LOAD_LIMIT }

export type SuperintendentLoad = "clear" | "stretched" | "over"

/** A person's own limits, else the org default, else the built-in ones. */
export function resolveSuperintendentLimits(
  own: SuperintendentLimits | null | undefined,
  orgDefault: SuperintendentLimits | null | undefined,
): SuperintendentLimits {
  return own ?? orgDefault ?? DEFAULT_SUPERINTENDENT_LIMITS
}

export function superintendentLoad(activeHouses: number, limits: SuperintendentLimits = DEFAULT_SUPERINTENDENT_LIMITS): SuperintendentLoad {
  if (activeHouses >= limits.max) return "over"
  if (activeHouses >= limits.warn) return "stretched"
  return "clear"
}

/** Houses a person can still be handed before assignment needs an override. */
export function superintendentRemaining(activeHouses: number, limits: SuperintendentLimits = DEFAULT_SUPERINTENDENT_LIMITS) {
  return Math.max(0, limits.max - activeHouses)
}
