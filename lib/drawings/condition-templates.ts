/**
 * Condition-template shape and grouping, shared by the server service and the
 * takeoff panel's library UI.
 *
 * These live here rather than in `lib/services/takeoff-templates.ts` because
 * the template library is a client component: importing the service for a pure
 * grouping helper pulled the whole server graph (search-index → apns →
 * auth/context → `server-only`) into the browser bundle. Pure, no I/O, no
 * server imports — keep it that way.
 */

import type { ConditionUom } from "@/lib/drawings/measure"

export const UNGROUPED_LABEL = "Ungrouped"

export interface ConditionTemplate {
  id: string
  org_id: string
  name: string
  uom: ConditionUom
  depth_in: number | null
  height_ft: number | null
  pitch_rise: number | null
  tons_per_cy: number | null
  cost_code_id: string | null
  color: string | null
  waste_pct: number
  unit_cost_cents: number | null
  share_with_clients: boolean
  notes: string | null
  group_name: string | null
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Shape the panel's "add from library" list wants: grouped, in display order. */
export function groupTemplates(
  templates: ConditionTemplate[],
): Array<{ group: string; templates: ConditionTemplate[] }> {
  const groups = new Map<string, ConditionTemplate[]>()
  for (const template of templates) {
    const key = template.group_name?.trim() || UNGROUPED_LABEL
    const list = groups.get(key)
    if (list) list.push(template)
    else groups.set(key, [template])
  }
  return Array.from(groups.entries())
    .map(([group, items]) => ({ group, templates: items }))
    .sort((a, b) => {
      // Ungrouped last: it is a leftover pile, not a category.
      if (a.group === UNGROUPED_LABEL) return 1
      if (b.group === UNGROUPED_LABEL) return -1
      return a.group.localeCompare(b.group)
    })
}
