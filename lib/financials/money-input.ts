/**
 * Turning what someone typed into integer cents.
 *
 * Money is integer cents everywhere in Arc, but a person posting a journal entry
 * types dollars — and types them with currency symbols, thousands separators, and
 * occasionally a typo. Getting this wrong silently corrupts a ledger, so it is
 * pure and tested rather than inlined into a form.
 *
 * The important choice here is that malformed input returns `null` rather than 0.
 * A parser that reads "1.2.3" as zero lets a wrong number through as if it were a
 * deliberate blank; the caller has to be told it could not read the value.
 */

/** Empty input is a genuine zero. Unparseable input is `null` — never silently 0. */
export function parseMoneyToCents(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === "") return 0

  // Currency symbols, spaces, and thousands separators are noise, not signal.
  const cleaned = trimmed.replace(/[$\s,]/g, "")
  // One optional leading sign, digits, and at most one decimal point.
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null

  // Parsed off the decimal string rather than by multiplying a float. `1.005` is
  // really 1.00499999999999989 in binary, so `Math.round(value * 100)` yields 100
  // and quietly loses a cent at exactly the boundaries money lands on.
  const [, sign, whole, fraction = ""] = match
  const padded = fraction.padEnd(3, "0").slice(0, 3)
  const wholeCents = Number(whole || "0") * 100
  const fractionCents = Number(padded.slice(0, 2))
  const roundUp = Number(padded[2]) >= 5 ? 1 : 0
  const magnitude = wholeCents + fractionCents + roundUp
  if (!Number.isSafeInteger(magnitude)) return null

  return sign === "-" && magnitude !== 0 ? -magnitude : magnitude
}
