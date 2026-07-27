import type {
  ReleaseNoteArea,
  ReleaseNoteItem,
  ReleaseNoteItemType,
} from "@/lib/services/release-notes"

export const AREA_ORDER: ReleaseNoteArea[] = [
  "general",
  "projects",
  "financials",
  "field",
  "admin",
  "mobile",
]

export const AREA_LABELS: Record<ReleaseNoteArea, string> = {
  general: "General",
  projects: "Projects",
  financials: "Financials",
  field: "Field",
  admin: "Admin",
  mobile: "Mobile",
}

export const ITEM_TYPE_ORDER: ReleaseNoteItemType[] = ["new", "improved", "fixed"]

/**
 * New/Improved/Fixed is taxonomy, not state, so it reads as a quiet label with a single
 * square of colour rather than a tinted chip — the chips turned every release into confetti.
 */
export const ITEM_TYPE_META: Record<
  ReleaseNoteItemType,
  { label: string; dotClassName: string }
> = {
  new: { label: "New", dotClassName: "bg-success" },
  improved: { label: "Improved", dotClassName: "bg-chart-2" },
  fixed: { label: "Fixed", dotClassName: "bg-warning" },
}

/**
 * Collapse a release's features into one block per change type, so the New/Improved/Fixed
 * badge is stated once and heads its list instead of repeating on every row. Groups follow
 * ITEM_TYPE_ORDER regardless of how the items were stored; order within a group is kept.
 */
export function groupItemsByType(items: ReleaseNoteItem[]) {
  return ITEM_TYPE_ORDER.map((type) => ({
    type,
    items: items.filter((item) => item.type === type),
  })).filter((group) => group.items.length > 0)
}
