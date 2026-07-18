import { TZDate } from "@date-fns/tz"
import { format, formatDistanceToNow } from "date-fns"
import type {
  BidScopeItem,
  BidSubmission,
  BidSubmissionItem,
} from "@/lib/services/bids"
import type { BidPackageStage } from "@/lib/bids/stage"

export interface SubmissionTotals {
  /** Sum of priced base/allowance/unit-price scope lines (alternates excluded). */
  base: number
  /** GC plugs added to cover excluded / no-bid base scope lines. */
  plugs: number
  /** Legacy lump-sum leveling adjustment. */
  lump: number
  /** base + plugs + lump — the apples-to-apples number. */
  leveled: number
}

/** Computes a submission's base and leveled totals. When the submission has
 * per-scope items, base sums priced non-alternate lines and plugs cover the
 * excluded/no-bid ones; otherwise it falls back to the vendor's headline total
 * (quote-mode legacy). */
export function computeSubmissionTotals(
  submission: Pick<BidSubmission, "total_cents" | "leveled_adjustment_cents" | "items">,
  scopeItems: BidScopeItem[],
): SubmissionTotals {
  const items = submission.items ?? []
  const scopeById = new Map(scopeItems.map((scope) => [scope.id, scope]))
  const lump = submission.leveled_adjustment_cents ?? 0

  if (items.length === 0) {
    const base = submission.total_cents ?? 0
    return { base, plugs: 0, lump, leveled: base + lump }
  }

  let base = 0
  let plugs = 0
  for (const item of items) {
    const scope = item.bid_scope_item_id ? scopeById.get(item.bid_scope_item_id) : undefined
    if (scope?.item_type === "alternate") continue
    if (item.response === "priced") {
      base += item.amount_cents ?? 0
    } else {
      plugs += item.gc_plug_cents ?? 0
    }
  }
  return { base, plugs, lump, leveled: base + plugs + lump }
}

/** The submission item that answers a given scope line, if any. */
export function itemForScope(
  submission: Pick<BidSubmission, "items">,
  scopeItemId: string,
): BidSubmissionItem | undefined {
  return (submission.items ?? []).find((item) => item.bid_scope_item_id === scopeItemId)
}

/** Where a bid package lives. Prospect packages have no project yet, which
 * disables the award-to-subcontract handoff and project-file linking. */
export interface BidWorkbenchContext {
  projectId?: string | null
  prospectId?: string | null
}

const DEFAULT_TZ = "America/New_York"

/** Whole-dollar USD; em dash for missing values (denser than "$0.00"). */
export function money(cents?: number | null): string {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

/** Parses "$12,500.50" → 1250050 cents; NaN on garbage, 0 on empty. */
export function parseCurrencyToCents(value: string): number {
  const normalized = value.replace(/[$,\s]/g, "")
  if (!normalized) return 0
  const amount = Number.parseFloat(normalized)
  if (!Number.isFinite(amount)) return Number.NaN
  return Math.round(amount * 100)
}

/** Signed one-decimal percent, e.g. "+12.5%" / "−8%" / "0%". */
export function formatDeviationPercent(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const rounded = Number(value.toFixed(1))
  if (rounded === 0) return "0%"
  const sign = rounded > 0 ? "+" : "−"
  return `${sign}${Math.abs(rounded)}%`
}

/** Signed whole-dollar USD, for variances. */
export function signedMoney(cents?: number | null): string {
  if (cents == null) return "—"
  const formatted = money(Math.abs(cents))
  if (cents > 0) return `+${formatted}`
  if (cents < 0) return `−${formatted}`
  return formatted
}

/** Short timezone abbreviation (e.g. "EDT") for a given instant + IANA zone. */
function tzAbbreviation(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(date)
    return parts.find((part) => part.type === "timeZoneName")?.value ?? ""
  } catch {
    return ""
  }
}

/** Renders a due date in its stored IANA timezone with a tz abbreviation. */
export function formatDueDate(dueAt?: string | null, dueTz?: string | null): string {
  if (!dueAt) return "No due date"
  const timeZone = dueTz || DEFAULT_TZ
  const instant = new Date(dueAt)
  try {
    const zoned = new TZDate(instant, timeZone)
    const abbr = tzAbbreviation(instant, timeZone)
    return `${format(zoned, "MMM d, yyyy · h:mm a")}${abbr ? ` ${abbr}` : ""}`
  } catch {
    return format(instant, "MMM d, yyyy · h:mm a")
  }
}

/** "in 3 days" / "2 days ago" relative to now. */
export function relativeDueDate(dueAt?: string | null): string | null {
  if (!dueAt) return null
  try {
    return formatDistanceToNow(new Date(dueAt), { addSuffix: true })
  } catch {
    return null
  }
}

export function isDuePast(dueAt?: string | null): boolean {
  if (!dueAt) return false
  return new Date(dueAt).getTime() < Date.now()
}

export const STAGE_ORDER: BidPackageStage[] = ["setup", "bidding", "leveling", "awarded"]

export const STAGE_LABELS: Record<BidPackageStage, string> = {
  setup: "Setup",
  bidding: "Bidding",
  leveling: "Leveling",
  awarded: "Awarded",
  cancelled: "Cancelled",
}

/** Humanized labels for activity event types. Unlisted types fall back to a
 * title-cased version of the raw type; entity ids are never surfaced raw. */
export const ACTIVITY_LABELS: Record<string, string> = {
  bid_package_created: "Package created",
  bid_package_updated: "Package updated",
  bid_package_status_changed: "Status changed",
  bid_invite_created: "Vendor invited",
  bid_invite_sent: "Invitation sent",
  bid_invite_resent: "Invitation resent",
  bid_invite_viewed: "Invitation viewed",
  bid_invite_declined: "Vendor declined",
  bid_invite_access_paused: "Access paused",
  bid_invite_access_resumed: "Access resumed",
  bid_invite_access_revoked: "Access revoked",
  bid_submission_received: "Bid received",
  bid_submission_revised: "Bid revised",
  bid_submission_created: "Bid entered",
  bid_submission_leveled: "Leveling updated",
  bid_addendum_created: "Addendum issued",
  bid_award_created: "Bid awarded",
  bid_award_rescinded: "Award rescinded",
  bid_rfi_answered: "RFI answered",
}

export function activityLabel(eventType: string): string {
  return (
    ACTIVITY_LABELS[eventType] ??
    eventType
      .replace(/_/g, " ")
      .replace(/^\w/, (character) => character.toUpperCase())
  )
}

/** Reads a human name from an activity payload without ever printing a UUID. */
export function activityActor(payload: Record<string, unknown>): string | null {
  const name =
    (payload.company_name as string | undefined) ??
    (payload.vendor_name as string | undefined) ??
    (payload.contact_name as string | undefined) ??
    null
  return name && name.trim().length > 0 ? name : null
}

/** US timezone options for the create sheet, keyed by IANA id. */
export const US_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Phoenix", label: "Arizona (AZ)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HT)" },
]
