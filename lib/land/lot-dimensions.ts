/**
 * `lots.dimensions` has ONE stored shape: snake_case (`width_ft`, `depth_ft`,
 * `acreage`, `irregular`). Forms and validation speak camelCase (`widthFt`);
 * the import pipeline speaks CSV column names (`width_ft`). Every writer goes
 * through `storeLotDimensions` and every reader through `readLotDimensions`, so
 * a lot imported from a spreadsheet and the same lot edited in the workbench
 * are the same record. Legacy camelCase keys are read, and removed on write.
 */
export interface LotDimensions {
  widthFt?: number
  depthFt?: number
  acreage?: number
  irregular?: boolean
}

export type LotDimensionsPatch = {
  [K in keyof LotDimensions]?: LotDimensions[K] | null
}

const STORED_KEYS = {
  widthFt: "width_ft",
  depthFt: "depth_ft",
  acreage: "acreage",
  irregular: "irregular",
} as const

const LEGACY_KEYS = ["widthFt", "depthFt"] as const

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function readLotDimensions(stored: Record<string, unknown> | null | undefined): LotDimensions {
  return {
    widthFt: finiteNumber(stored?.width_ft ?? stored?.widthFt),
    depthFt: finiteNumber(stored?.depth_ft ?? stored?.depthFt),
    acreage: finiteNumber(stored?.acreage),
    irregular: typeof stored?.irregular === "boolean" ? stored.irregular : undefined,
  }
}

/**
 * The stored object for a lot, preserving unrelated keys (an import's city and
 * postal code ride in here too).
 *
 * `replace` is a dimensions edit: the four fields become exactly `next`, so an
 * omitted field is cleared. `fill` is an import row: only the fields the row
 * supplied change, so a blank spreadsheet cell never erases a measured width.
 */
export function storeLotDimensions(
  existing: Record<string, unknown> | null | undefined,
  next: LotDimensionsPatch,
  mode: "replace" | "fill",
): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...(existing ?? {}) }
  const current = readLotDimensions(existing)
  for (const key of LEGACY_KEYS) delete stored[key]
  for (const field of Object.keys(STORED_KEYS) as Array<keyof LotDimensions>) {
    const value = next[field]
    const resolved = mode === "replace" ? value : value === undefined || value === null ? current[field] : value
    if (resolved === undefined || resolved === null) delete stored[STORED_KEYS[field]]
    else stored[STORED_KEYS[field]] = resolved
  }
  return stored
}
