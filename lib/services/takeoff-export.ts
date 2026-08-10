import "server-only"

/**
 * The takeoff rollup as a CSV.
 *
 * Quantities leave a takeoff two ways. The sync path pushes them onto an
 * estimate, a bid package, or a plan takeoff and keeps provenance attached —
 * that is the one that matters. This is the other one: the estimator who needs
 * the numbers in a spreadsheet, in a supplier's format, or in an email tonight.
 *
 * The export is exactly as honest as the panel. Every flag the panel shows —
 * unscaled members, measurements pending review after a revision, quantities
 * stranded on a superseded sheet, deductions, a net-negative condition, sheets
 * that look double-counted — is a column here. An export that quietly dropped
 * them would be a cleaner file and a worse document, because the person reading
 * it downstream has no other way to learn that a number is provisional.
 */

import {
  conditionSourceUom,
  MEASURE_UOM_LABELS,
  type ConditionUom,
} from "@/lib/drawings/measure"
import { getConditionRollup, type ConditionRollup } from "@/lib/services/takeoff"
import type { ConditionRollupFilters } from "@/lib/validation/takeoff"

const HEADERS = [
  "Condition",
  "Reports in",
  "Measured in",
  "Measured quantity",
  "Waste %",
  "Effective quantity",
  "Unit rate",
  "Rate source",
  "Extended",
  "Cost code",
  "Sheet",
  "Sheet title",
  "Row type",
  "Measurements",
  "Deductions",
  "Pending review",
  "On superseded sheet",
  "Awaiting scale",
  "Flags",
] as const

/**
 * RFC 4180: quote anything containing a delimiter, a quote, or a newline, and
 * double any embedded quote. A condition called `4" slab, garage` is normal.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  const text = String(value)
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ""
  // Formatted at the edge, per the money rule — cents everywhere else.
  return (cents / 100).toFixed(2)
}

function flagsFor(rollup: ConditionRollup): string {
  const flags: string[] = []
  if (rollup.net_negative) flags.push("NET NEGATIVE — deductions exceed additions")
  if (rollup.unscaled_markup_count > 0) {
    flags.push(`${rollup.unscaled_markup_count} awaiting scale`)
  }
  if (rollup.pending_review_count > 0) {
    flags.push(`${rollup.pending_review_count} pending revision review (not counted)`)
  }
  if (rollup.stale_markup_count > 0) {
    flags.push(`${rollup.stale_markup_count} on a superseded sheet (not counted)`)
  }
  if (rollup.duplicate_suspect_sheets.length > 0) {
    flags.push(`possible double count across ${rollup.duplicate_suspect_sheets.join(", ")}`)
  }
  if (rollup.sheets_truncated > 0) {
    flags.push(`${rollup.sheets_truncated} more sheets not itemised below`)
  }
  if (rollup.sync?.detached) flags.push("synced line detached")
  else if (rollup.sync?.hand_edited) flags.push("synced line edited by hand")
  else if (rollup.sync?.quantity_changed) flags.push("synced line out of date")
  return flags.join("; ")
}

export interface TakeoffExport {
  filename: string
  csv: string
  condition_count: number
}

/**
 * Render every condition in a scope, each followed by its per-sheet breakdown.
 *
 * Sheet rows repeat the condition name rather than relying on indentation,
 * because the first thing anyone does with this file is sort it.
 */
export async function exportConditionRollupCsv(
  filters: ConditionRollupFilters,
  orgId?: string,
): Promise<TakeoffExport> {
  const rollups = await getConditionRollup(filters, orgId)

  const lines: string[] = [HEADERS.map(csvCell).join(",")]

  for (const rollup of rollups) {
    const { condition } = rollup
    const sourceUom = conditionSourceUom(condition.uom, condition)

    lines.push(
      [
        condition.name,
        MEASURE_UOM_LABELS[condition.uom as ConditionUom],
        // Only interesting when it differs; blank keeps the common case quiet.
        sourceUom === condition.uom ? "" : MEASURE_UOM_LABELS[sourceUom],
        rollup.measured_quantity,
        condition.waste_pct,
        rollup.effective_quantity,
        money(rollup.effective_unit_cost_cents),
        rollup.rate_source ?? "none",
        money(rollup.extended_cents),
        rollup.cost_code ? `${rollup.cost_code.code} ${rollup.cost_code.name}` : "",
        "",
        "",
        "condition",
        rollup.markup_count,
        rollup.deduction_count,
        rollup.pending_review_count,
        rollup.stale_markup_count,
        rollup.unscaled_markup_count,
        flagsFor(rollup),
      ]
        .map(csvCell)
        .join(","),
    )

    // The conversion, spelled out, so a reader can check a CY number without
    // the app. Skipped when the condition reports what it measured.
    if (rollup.conversion_summary) {
      lines.push(
        [
          condition.name,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "conversion",
          "",
          "",
          "",
          "",
          "",
          rollup.conversion_summary,
        ]
          .map(csvCell)
          .join(","),
      )
    }

    for (const sheet of rollup.sheets) {
      lines.push(
        [
          condition.name,
          MEASURE_UOM_LABELS[condition.uom as ConditionUom],
          "",
          sheet.quantity,
          "",
          "",
          "",
          "",
          "",
          "",
          sheet.sheet_number,
          sheet.sheet_title ?? "",
          "sheet",
          sheet.markup_count,
          sheet.deduction_count,
          "",
          "",
          "",
          rollup.duplicate_suspect_sheets.includes(sheet.sheet_number)
            ? "possible double count"
            : "",
        ]
          .map(csvCell)
          .join(","),
      )
    }
  }

  const scopeLabel = filters.project_id ?? filters.house_plan_version_id ?? "takeoff"
  return {
    filename: `takeoff-${scopeLabel.slice(0, 8)}.csv`,
    csv: lines.join("\n"),
    condition_count: rollups.length,
  }
}
