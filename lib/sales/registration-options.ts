/**
 * The closed lists a registration card offers, shared by the card that creates a
 * lead and the sheet that corrects one. Two copies would drift the first time
 * someone adds a price band, and then the same buyer would read differently
 * depending on which form last touched them.
 */

/** How the buyer says they found the community. Stored on `prospects.source`. */
export const HEARD_ABOUT = [
  "Drive-by",
  "Website",
  "Realtor",
  "Referral",
  "Zillow",
  "Social media",
  "Sign",
  "Repeat buyer",
  "Other",
]

export const TIMEFRAMES = ["Immediately", "1–3 months", "3–6 months", "6–12 months", "Over a year"]

export const PRICE_RANGES = [
  "Under $300K",
  "$300–400K",
  "$400–500K",
  "$500–650K",
  "$650–800K",
  "Over $800K",
]

/**
 * The list plus whatever is already stored, when that is something else.
 *
 * A lead's source can be a channel label the card wrote ("Walk-in"), a band from
 * an older vocabulary, or an imported value. Without this the edit sheet would
 * render an unmatched value as "Not set" and quietly erase it on the next save.
 */
export function withCurrent(options: string[], current: string | null): string[] {
  const value = current?.trim()
  if (!value || options.includes(value)) return options
  return [value, ...options]
}
