import type { HousePlanVersionDto } from "@/lib/services/house-plans"

export type ReleaseGate = {
  key: string
  label: string
  detail: string
  ok: boolean
  required: boolean
}

/**
 * What has to be true before a plan version can be released. Mirrors the checks
 * `releasePlanVersion` enforces server-side — the required gates here are the same
 * three it throws on, so the button is never enabled into a server error.
 */
export function releaseGates(version: HousePlanVersionDto): ReleaseGate[] {
  return [
    {
      key: "cost",
      label: "Cost basis",
      detail:
        version.takeoff_line_count > 0
          ? `${version.takeoff_line_count} takeoff lines`
          : version.budget_template_id
            ? "Budget template"
            : "Add takeoff lines or pick a budget template",
      ok: version.takeoff_line_count > 0 || Boolean(version.budget_template_id),
      required: true,
    },
    {
      key: "schedule",
      label: "Schedule",
      detail: version.schedule_template_id ? "Template selected" : "Every start needs a schedule to generate",
      ok: Boolean(version.schedule_template_id),
      required: true,
    },
    {
      key: "drawings",
      label: "Plan set",
      detail: version.drawing_source_file_id ? "PDF attached" : "Starts begin without drawings",
      ok: Boolean(version.drawing_source_file_id),
      required: false,
    },
    {
      key: "checklists",
      label: "Checklists",
      detail: version.checklist_template_ids.length > 0 ? `${version.checklist_template_ids.length} attached` : "No field checklists seeded",
      ok: version.checklist_template_ids.length > 0,
      required: false,
    },
    {
      key: "selections",
      label: "Selections",
      detail:
        version.selection_category_ids.length > 0
          ? `${version.selection_category_ids.length} categories`
          : "Buyers start with no selection sheet",
      ok: version.selection_category_ids.length > 0,
      required: false,
    },
  ]
}

export function blockingGates(version: HousePlanVersionDto): ReleaseGate[] {
  return releaseGates(version).filter((gate) => gate.required && !gate.ok)
}
