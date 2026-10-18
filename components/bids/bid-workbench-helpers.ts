import { TZDate } from "@date-fns/tz"
import { format, formatDistanceToNow } from "date-fns"
import type { BidPackageStage } from "@/lib/bids/stage"

/** Where a bid package lives. Precon-phase projects collect and level bids
 * but cannot award — the server refuses commitments until activation. */
export interface BidWorkbenchContext {
  projectId?: string | null
}

export const DEFAULT_TZ = "America/New_York"

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

/** The instant a wall-clock date and time mean in the package's timezone. */
export function zonedDueAt(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number)
  const [hours, minutes] = time.split(":").map(Number)
  const zoned = new TZDate(year, month - 1, day, Number.isFinite(hours) ? hours : 17, Number.isFinite(minutes) ? minutes : 0, timeZone)
  // TZDate prints its own offset; the API expects UTC.
  return new Date(zoned.getTime()).toISOString()
}

/** Splits a stored due instant back into the wall-clock date and time of its timezone. */
export function dueParts(dueAt: string | null | undefined, timeZone: string): { date: string; time: string } {
  if (!dueAt) return { date: "", time: "17:00" }
  const zoned = new TZDate(new Date(dueAt), timeZone)
  return { date: format(zoned, "yyyy-MM-dd"), time: format(zoned, "HH:mm") }
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
  bid_awarded: "Awarded",
  "bid_package.awarded_to_price_book": "Awarded to the price book",
  bid_invite_removed: "Trade removed",
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
