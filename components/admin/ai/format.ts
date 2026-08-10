/** Shared number formatting for the AI console. Money never rounds to a lie. */

export function money(value: number) {
  if (value === 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1000) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}

export function compact(value: number) {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** A per-million-token rate. Null is "we do not know", which is not zero. */
export function rate(value: number | null) {
  if (value === null) return "—"
  if (value === 0) return "$0"
  // Sub-dime rates carry a third decimal; rounding $0.075 to $0.08 is a 7% lie.
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`
}

export function ratePair(input: number | null, output: number | null) {
  if (input === null && output === null) return null
  return `${rate(input)} / ${rate(output)}`
}
