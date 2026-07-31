/**
 * Condition colors.
 *
 * A takeoff condition's color is its IDENTITY on the sheet: the geometry drawn
 * in `#2A5CDA` is the LVP-flooring condition, everywhere it appears. This is a
 * deliberate, documented carve-out from the "color is state, never identity"
 * rule in docs/design.md — it applies to geometry painted onto a customer's
 * drawing, not to app chrome, and there is no other way to tell twelve
 * overlapping measured regions apart at a glance.
 *
 * The values are hex because that is what the SVG overlay, the `drawing_markups`
 * `data.color` contract, and pdf-lib all consume; a CSS variable cannot cross
 * into a flattened PDF. Each one is a light-mode `--chart-*` / state token hue
 * re-rendered at a lightness and chroma that stays legible on white paper and
 * distinguishable from its neighbours (source oklch noted per entry).
 *
 * The list is FIXED and ORDER-STABLE: `conditionColorAt(n)` must keep returning
 * the same color for the same n forever, or existing conditions change color.
 * Append only.
 */

export interface ConditionColor {
  hex: string
  /** Shown in the color picker. */
  label: string
}

export const CONDITION_PALETTE: readonly ConditionColor[] = [
  { hex: "#2A5CDA", label: "Blue" },      // oklch(0.52 0.20 264) — chart-1
  { hex: "#05893E", label: "Green" },     // oklch(0.55 0.15 150) — chart-4
  { hex: "#C96900", label: "Amber" },     // oklch(0.62 0.16 60)  — chart-3
  { hex: "#7B47BF", label: "Purple" },    // oklch(0.52 0.18 300) — chart-5
  { hex: "#008A92", label: "Cyan" },      // oklch(0.56 0.13 200) — chart-2
  { hex: "#CC272E", label: "Red" },       // oklch(0.55 0.20 25)  — destructive
  { hex: "#007FBC", label: "Azure" },     // oklch(0.55 0.16 230)
  { hex: "#B73095", label: "Magenta" },   // oklch(0.55 0.20 340)
  { hex: "#CF5604", label: "Orange" },    // oklch(0.60 0.17 45)
  { hex: "#00896D", label: "Teal" },      // oklch(0.55 0.13 175)
  { hex: "#5E48C8", label: "Violet" },    // oklch(0.50 0.19 285)
  { hex: "#798300", label: "Olive" },     // oklch(0.58 0.14 115)
] as const

export const CONDITION_COLORS: readonly string[] = CONDITION_PALETTE.map((c) => c.hex)

/** Round-robin assignment so the Nth condition on a project gets a fresh color. */
export function conditionColorAt(index: number): string {
  const size = CONDITION_COLORS.length
  const safe = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0
  return CONDITION_COLORS[safe % size]
}

/**
 * Next unused color for a project, falling back to round-robin once all twelve
 * are taken. Keeps small takeoffs unambiguous without ever failing.
 */
export function nextConditionColor(usedColors: Iterable<string>): string {
  const used = new Set<string>()
  for (const color of usedColors) {
    if (typeof color === "string") used.add(color.toUpperCase())
  }
  const free = CONDITION_COLORS.find((color) => !used.has(color))
  return free ?? conditionColorAt(used.size)
}

export function isConditionColor(value: unknown): value is string {
  return typeof value === "string" && CONDITION_COLORS.includes(value.toUpperCase())
}
