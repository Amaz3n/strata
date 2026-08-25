/**
 * A navigation that resolves in under a quarter second needs no feedback at
 * all: sighted users get a flash they did not need, screen-reader users get an
 * announcement for a page that already arrived. Both the mark and its polite
 * status hang off this single threshold so the two can never drift apart.
 */
export const LOADING_REVEAL_DELAY_MS = 250

/** Schedules the reveal and returns the cleanup that cancels it. */
export function scheduleLoadingReveal(reveal: () => void): () => void {
  const timer = setTimeout(reveal, LOADING_REVEAL_DELAY_MS)
  return () => clearTimeout(timer)
}
