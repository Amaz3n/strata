/**
 * `lots.dimensions` has ONE stored shape: snake_case (`width_ft`, `depth_ft`,
 * `acreage`, `irregular`, `corner_lot`, and the lot's own setbacks
 * `front_setback_ft`, `rear_setback_ft`, `side_setback_ft`,
 * `corner_side_setback_ft`). Forms and validation speak camelCase (`widthFt`);
 * the import pipeline speaks CSV column names (`width_ft`). Every writer goes
 * through `storeLotDimensions` and every reader through `readLotDimensions`, so
 * a lot imported from a spreadsheet and the same lot edited in the workbench
 * are the same record. Legacy camelCase keys are read, and removed on write.
 */
/**
 * Setbacks in feet. A community stores its defaults under the same keys
 * (`communities.setbacks`), so `readSetbacks` reads either, and a lot's own
 * value wins over the community's one key at a time.
 */
export interface Setbacks {
  frontSetbackFt?: number
  rearSetbackFt?: number
  sideSetbackFt?: number
  cornerSideSetbackFt?: number
}

export type SetbacksPatch = {
  [K in keyof Setbacks]?: Setbacks[K] | null
}

export interface LotDimensions extends Setbacks {
  widthFt?: number
  depthFt?: number
  acreage?: number
  irregular?: boolean
  /** A corner lot takes the corner-side setback on its street side. */
  corner?: boolean
}

export type LotDimensionsPatch = {
  [K in keyof LotDimensions]?: LotDimensions[K] | null
}

const SETBACK_KEYS = {
  frontSetbackFt: "front_setback_ft",
  rearSetbackFt: "rear_setback_ft",
  sideSetbackFt: "side_setback_ft",
  cornerSideSetbackFt: "corner_side_setback_ft",
} as const

const STORED_KEYS = {
  widthFt: "width_ft",
  depthFt: "depth_ft",
  acreage: "acreage",
  irregular: "irregular",
  corner: "corner_lot",
  ...SETBACK_KEYS,
} as const

const LEGACY_KEYS = ["widthFt", "depthFt"] as const

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function readSetbacks(stored: Record<string, unknown> | null | undefined): Setbacks {
  return {
    frontSetbackFt: finiteNumber(stored?.front_setback_ft),
    rearSetbackFt: finiteNumber(stored?.rear_setback_ft),
    sideSetbackFt: finiteNumber(stored?.side_setback_ft),
    cornerSideSetbackFt: finiteNumber(stored?.corner_side_setback_ft),
  }
}

/** A community's setbacks object, exactly the fields given (an omitted one is cleared). */
export function storeSetbacks(next: SetbacksPatch): Record<string, number> {
  const stored: Record<string, number> = {}
  for (const field of Object.keys(SETBACK_KEYS) as Array<keyof Setbacks>) {
    const value = next[field]
    if (value !== undefined && value !== null) stored[SETBACK_KEYS[field]] = value
  }
  return stored
}

export function readLotDimensions(stored: Record<string, unknown> | null | undefined): LotDimensions {
  return {
    widthFt: finiteNumber(stored?.width_ft ?? stored?.widthFt),
    depthFt: finiteNumber(stored?.depth_ft ?? stored?.depthFt),
    acreage: finiteNumber(stored?.acreage),
    irregular: typeof stored?.irregular === "boolean" ? stored.irregular : undefined,
    corner: typeof stored?.corner_lot === "boolean" ? stored.corner_lot : undefined,
    ...readSetbacks(stored),
  }
}

/**
 * The stored object for a lot, preserving unrelated keys (an import's city and
 * postal code ride in here too).
 *
 * `replace` is a dimensions edit: the fields become exactly `next`, so an
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
