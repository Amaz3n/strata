import type { CostType } from "@/lib/cost-types"
import type { CostCode } from "@/lib/types"

/**
 * Takeoffs arrive from a spreadsheet, so the import has to accept what a
 * spreadsheet actually puts on the clipboard: tab-delimited cells, a header row
 * or none, dollar signs, thousands separators, and codes written a dozen ways.
 *
 * Pure and client-safe — the dialog re-parses on every keystroke to show the
 * estimator exactly which rows will land before anything is committed.
 */

export type TakeoffImportField = "elevation" | "costCode" | "description" | "quantity" | "uom" | "unitCost"

/** A parsed row in the shape the bill editor holds a draft line. */
export type TakeoffImportLine = {
  costCodeId: string
  costType: CostType | null
  description: string
  quantity: string
  uom: string
  unitCostDollars: string
  elevationId: string
}

export type TakeoffImportRow = {
  rowNumber: number
  cells: string[]
  line: TakeoffImportLine | null
  error: string | null
}

export type TakeoffImportPreview = {
  delimiter: "tab" | "comma"
  hasHeader: boolean
  /** Which field each source column feeds; null for a column that is ignored. */
  fields: (TakeoffImportField | null)[]
  rows: TakeoffImportRow[]
  readyCount: number
  errorCount: number
  /** Set when the shape is unusable at all — no cost code column, nothing pasted. */
  fatal: string | null
}

export type TakeoffImportElevation = { id: string; code: string }

export const TAKEOFF_CSV_HEADERS = ["elevation", "cost code", "description", "quantity", "uom", "unit cost"] as const

const FIELD_ALIASES: Record<TakeoffImportField, string[]> = {
  elevation: ["elevation", "elev", "elevations", "elevationcode"],
  costCode: ["costcode", "code", "costcodeid", "itemcode", "phase", "phasecode"],
  description: ["description", "desc", "item", "scope", "lineitem", "line", "material"],
  quantity: ["quantity", "qty", "takeoffqty", "qtytakeoff", "count"],
  uom: ["uom", "unit", "units", "u/m", "unitofmeasure", "measure"],
  unitCost: ["unitcost", "cost", "unitprice", "price", "rate", "$/unit", "unit$", "costunit"],
}

/** Header cells and cost codes are compared with punctuation and spacing removed. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._\-#]/g, "")
}

function splitRow(row: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ""
  let quoted = false
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]
    if (quoted) {
      if (char !== '"') {
        current += char
      } else if (row[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = false
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === delimiter) {
      cells.push(current)
      current = ""
    } else current += char
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** Money and quantities survive `$`, thousands separators, and parentheses-negatives. */
function parseNumber(raw: string): number | null | "invalid" {
  const cleaned = raw.replace(/[$\s,]/g, "").replace(/^\((.*)\)$/, "-$1")
  if (cleaned === "") return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return "invalid"
  return value
}

function matchField(header: string): TakeoffImportField | null {
  const key = normalize(header)
  if (!key) return null
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [TakeoffImportField, string[]][]) {
    if (aliases.includes(key)) return field
  }
  return null
}

type CodeLookup = {
  byKey: Map<string, CostCode>
  byName: Map<string, CostCode | null>
}

function buildCodeLookup(costCodes: CostCode[]): CodeLookup {
  const byKey = new Map<string, CostCode>()
  const byName = new Map<string, CostCode | null>()
  for (const code of costCodes) {
    byKey.set(code.id, code)
    const key = normalize(code.code)
    if (key && !byKey.has(key)) byKey.set(key, code)
    const name = normalize(code.name)
    // A name that repeats can't identify a line, so it resolves to nothing rather
    // than to whichever code happened to load first.
    byName.set(name, byName.has(name) ? null : code)
  }
  return { byKey, byName }
}

function resolveCode(raw: string, lookup: CodeLookup): CostCode | null | "ambiguous" {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const direct = lookup.byKey.get(trimmed) ?? lookup.byKey.get(normalize(trimmed))
  if (direct) return direct
  const key = normalize(trimmed)
  if (!lookup.byName.has(key)) return null
  return lookup.byName.get(key) ?? "ambiguous"
}

function detectDelimiter(lines: string[]): "tab" | "comma" {
  return lines.some((line) => line.includes("\t")) ? "tab" : "comma"
}

/**
 * With no header row the column order has to be guessed. The documented Arc
 * format leads with elevation; everything exported from an estimating package
 * leads with the cost code. Sniff column one against the plan's own elevations.
 */
function positionalFields(rows: string[][], elevations: TakeoffImportElevation[]): (TakeoffImportField | null)[] {
  const elevationTokens = new Set(["base", "-", "", "all", ...elevations.map((item) => normalize(item.code))])
  const leadsWithElevation =
    rows.length > 0 &&
    rows.every((cells) => elevationTokens.has(normalize(cells[0] ?? ""))) &&
    rows.some((cells) => cells.length >= 5)
  return leadsWithElevation
    ? ["elevation", "costCode", "description", "quantity", "uom", "unitCost"]
    : ["costCode", "description", "quantity", "uom", "unitCost"]
}

export function parseTakeoffPaste({
  text,
  costCodes,
  elevations,
  headerMode = "auto",
}: {
  text: string
  costCodes: CostCode[]
  elevations: TakeoffImportElevation[]
  headerMode?: "auto" | "header" | "none"
}): TakeoffImportPreview {
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim() !== "")
  const empty: TakeoffImportPreview = {
    delimiter: "comma",
    hasHeader: false,
    fields: [],
    rows: [],
    readyCount: 0,
    errorCount: 0,
    fatal: null,
  }
  if (rawLines.length === 0) return empty

  const delimiter = detectDelimiter(rawLines)
  const split = rawLines.map((line) => splitRow(line, delimiter === "tab" ? "\t" : ","))
  const headerCandidates = split[0].map(matchField)
  const looksLikeHeader = headerCandidates.filter(Boolean).length >= 2
  const hasHeader = headerMode === "header" || (headerMode === "auto" && looksLikeHeader)

  const body = hasHeader ? split.slice(1) : split
  const fields = hasHeader ? headerCandidates : positionalFields(body, elevations)

  if (!fields.includes("costCode")) {
    return {
      ...empty,
      delimiter,
      hasHeader,
      fields,
      fatal: hasHeader
        ? "No cost code column. Name one of the columns “cost code”, or turn the header row off."
        : "No cost code column could be identified.",
    }
  }
  if (body.length === 0) {
    return { ...empty, delimiter, hasHeader, fields, fatal: "Only a header row was pasted." }
  }

  const lookup = buildCodeLookup(costCodes)
  const elevationByKey = new Map<string, TakeoffImportElevation>()
  for (const elevation of elevations) {
    elevationByKey.set(elevation.id, elevation)
    elevationByKey.set(normalize(elevation.code), elevation)
  }

  const cell = (cells: string[], field: TakeoffImportField): string => {
    const index = fields.indexOf(field)
    return index === -1 ? "" : cells[index] ?? ""
  }

  const rows: TakeoffImportRow[] = body.map((cells, index) => {
    const rowNumber = index + (hasHeader ? 2 : 1)
    const fail = (error: string): TakeoffImportRow => ({ rowNumber, cells, line: null, error })

    const code = resolveCode(cell(cells, "costCode"), lookup)
    if (code === "ambiguous") return fail(`“${cell(cells, "costCode")}” matches more than one cost code`)
    if (!code) {
      const raw = cell(cells, "costCode")
      return fail(raw ? `Cost code “${raw}” was not found` : "Cost code is required")
    }

    const elevationRaw = cell(cells, "elevation")
    const elevationKey = normalize(elevationRaw)
    let elevationId = "base"
    if (elevationKey && elevationKey !== "base" && elevationKey !== "-" && elevationKey !== "all") {
      const elevation = elevationByKey.get(elevationRaw.trim()) ?? elevationByKey.get(elevationKey)
      if (!elevation) return fail(`Elevation “${elevationRaw}” is not on this plan`)
      elevationId = elevation.id
    }

    const quantity = parseNumber(cell(cells, "quantity"))
    if (quantity === "invalid") return fail(`Quantity “${cell(cells, "quantity")}” is not a number`)
    if (quantity != null && quantity < 0) return fail("Quantity cannot be negative")

    const unitCost = parseNumber(cell(cells, "unitCost"))
    if (unitCost === "invalid") return fail(`Unit cost “${cell(cells, "unitCost")}” is not a number`)
    if (unitCost != null && unitCost < 0) return fail("Unit cost cannot be negative")

    return {
      rowNumber,
      cells,
      error: null,
      line: {
        costCodeId: code.id,
        costType: code.cost_type ?? null,
        description: cell(cells, "description") || code.name,
        // A row that only carries a code and a price is a lump sum; one is the
        // quantity the estimator meant.
        quantity: String(quantity ?? 1),
        uom: cell(cells, "uom") || code.unit || "ea",
        unitCostDollars: unitCost == null ? "" : unitCost.toFixed(2),
        elevationId,
      },
    }
  })

  return {
    delimiter,
    hasHeader,
    fields,
    rows,
    readyCount: rows.filter((row) => row.line).length,
    errorCount: rows.filter((row) => row.error).length,
    fatal: null,
  }
}
