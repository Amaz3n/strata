import type { MemberPermissionOverride, PermissionOption, TeamMember } from "@/lib/types"

/** Role key → the permission keys that role grants (from `role_permissions`). */
export type RolePermissionMap = Record<string, string[]>

export type RosterFacet = "active" | "pending" | "archived" | "all"
export type RosterSortKey = "name" | "role" | "access" | "activity"
export type MfaFilter = "any" | "on" | "off"

export interface RosterFilters {
  query: string
  facet: RosterFacet
  role: string | "all"
  mfa: MfaFilter
  sort: { key: RosterSortKey; dir: "asc" | "desc" }
}

export const DEFAULT_FILTERS: RosterFilters = {
  query: "",
  facet: "active",
  role: "all",
  mfa: "any",
  sort: { key: "name", dir: "asc" },
}

/**
 * The audit-meaningful money signal: keys that let someone move or approve
 * money. Deliberately narrower than "touches the Financials category" — nearly
 * every internal member has `invoice.read`, so that would light up everyone.
 */
export const MONEY_RELEASE_KEYS = new Set([
  "payment.release",
  "draw.approve",
  "invoice.approve",
  "invoice.send",
  "bill.approve",
  "commitment.approve",
  "change_order.approve",
  "retainage.manage",
  "budget.approve",
  "vpo.approve",
  "vpo.approve_large",
])

export function isAdminRole(role: string, rolePermissions: RolePermissionMap): boolean {
  return (rolePermissions[role] ?? []).includes("org.admin")
}

/**
 * The member's effective permission set = the role's grants, minus any `deny`
 * override, plus any `grant` override. Admin roles hold everything, so callers
 * that care about admin should short-circuit with {@link isAdminRole}.
 */
export function effectivePermissions(member: TeamMember, rolePermissions: RolePermissionMap): Set<string> {
  const set = new Set(rolePermissions[member.role] ?? [])
  for (const override of member.permission_overrides ?? []) {
    if (override.effect === "grant") set.add(override.permission_key)
    else set.delete(override.permission_key)
  }
  return set
}

export function overrideCounts(member: TeamMember): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const override of member.permission_overrides ?? []) {
    if (override.effect === "grant") added += 1
    else removed += 1
  }
  return { added, removed }
}

export function canReleaseMoney(member: TeamMember, rolePermissions: RolePermissionMap): boolean {
  if (isAdminRole(member.role, rolePermissions)) return true
  const effective = effectivePermissions(member, rolePermissions)
  for (const key of MONEY_RELEASE_KEYS) {
    if (effective.has(key)) return true
  }
  return false
}

export function hasLaborRates(member: TeamMember): boolean {
  return (member.labor_cost_rate_cents ?? 0) > 0 || (member.labor_bill_rate_cents ?? 0) > 0
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const source = name?.trim() || email?.trim() || ""
  if (!source) return "?"
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return parts
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/** A pending member whose name fell back to their email reads "Invited", never "Unknown". */
export function displayName(member: TeamMember): { label: string; muted: boolean } {
  const name = member.user.full_name?.trim()
  if (name && name !== member.user.email) return { label: name, muted: false }
  if (member.status === "invited") return { label: "Invited", muted: true }
  return { label: member.user.email || "Unknown", muted: false }
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = MS_PER_MINUTE * 60
const MS_PER_DAY = MS_PER_HOUR * 24

export function relativeTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const diff = now - then
  if (diff < MS_PER_MINUTE) return "just now"
  if (diff < MS_PER_HOUR) {
    const m = Math.floor(diff / MS_PER_MINUTE)
    return `${m}m ago`
  }
  if (diff < MS_PER_DAY) {
    const h = Math.floor(diff / MS_PER_HOUR)
    return `${h}h ago`
  }
  const d = Math.floor(diff / MS_PER_DAY)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export interface ActivityDescriptor {
  word: string
  detail: string | null
  tone?: "warning" | "muted"
}

export function activityDescriptor(member: TeamMember, now: number): ActivityDescriptor {
  if (member.status === "suspended") {
    return { word: "Archived", detail: null, tone: "muted" }
  }
  if (member.status === "invited") {
    const sent = relativeTime(member.created_at, now)
    return { word: "Pending", detail: sent ? `Invited ${sent}` : "Invite sent", tone: "warning" }
  }
  const seen = relativeTime(member.last_active_at, now)
  return { word: "Active", detail: seen ? `Seen ${seen}` : "Never signed in", tone: seen ? undefined : "muted" }
}

export interface RosterCounts {
  active: number
  pending: number
  archived: number
  all: number
  admins: number
  noMfa: number
  noRates: number
}

export function rosterCounts(members: TeamMember[], rolePermissions: RolePermissionMap): RosterCounts {
  const counts: RosterCounts = { active: 0, pending: 0, archived: 0, all: members.length, admins: 0, noMfa: 0, noRates: 0 }
  for (const member of members) {
    if (member.status === "suspended") counts.archived += 1
    else if (member.status === "invited") counts.pending += 1
    else counts.active += 1

    if (member.status !== "suspended") {
      if (isAdminRole(member.role, rolePermissions)) counts.admins += 1
      if (!member.mfa_enabled) counts.noMfa += 1
      if (!hasLaborRates(member)) counts.noRates += 1
    }
  }
  return counts
}

function matchesFacet(member: TeamMember, facet: RosterFacet): boolean {
  switch (facet) {
    case "active":
      return member.status === "active"
    case "pending":
      return member.status === "invited"
    case "archived":
      return member.status === "suspended"
    case "all":
      return true
  }
}

export function filterMembers(members: TeamMember[], filters: RosterFilters): TeamMember[] {
  const query = filters.query.trim().toLowerCase()
  return members.filter((member) => {
    if (!matchesFacet(member, filters.facet)) return false
    if (filters.role !== "all" && member.role !== filters.role) return false
    if (filters.mfa === "on" && !member.mfa_enabled) return false
    if (filters.mfa === "off" && member.mfa_enabled) return false
    if (query) {
      const haystack = [member.user.full_name, member.user.email, member.role_label]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

const STATUS_ORDER: Record<TeamMember["status"], number> = { active: 0, invited: 1, suspended: 2 }

export function sortMembers(members: TeamMember[], sort: RosterFilters["sort"]): TeamMember[] {
  const dir = sort.dir === "asc" ? 1 : -1
  const sorted = [...members]
  sorted.sort((a, b) => {
    switch (sort.key) {
      case "role": {
        const cmp = (a.role_label ?? "").localeCompare(b.role_label ?? "")
        return cmp !== 0 ? cmp * dir : nameCompare(a, b)
      }
      case "access": {
        const cmp = accessRank(a) - accessRank(b)
        return cmp !== 0 ? cmp * dir : nameCompare(a, b)
      }
      case "activity": {
        // Never-signed-in sinks to the bottom regardless of direction.
        const at = a.last_active_at ? new Date(a.last_active_at).getTime() : Number.NEGATIVE_INFINITY
        const bt = b.last_active_at ? new Date(b.last_active_at).getTime() : Number.NEGATIVE_INFINITY
        if (at === bt) return nameCompare(a, b)
        if (at === Number.NEGATIVE_INFINITY) return 1
        if (bt === Number.NEGATIVE_INFINITY) return -1
        return (bt - at) * dir
      }
      case "name":
      default: {
        const cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        if (cmp !== 0) return cmp
        return nameCompare(a, b) * dir
      }
    }
  })
  return sorted
}

function accessRank(member: TeamMember): number {
  return member.project_scope === "assigned" ? 0 : 1
}

function nameCompare(a: TeamMember, b: TeamMember): number {
  const an = displayName(a).label.toLowerCase()
  const bn = displayName(b).label.toLowerCase()
  return an.localeCompare(bn)
}

function csvCell(value: string | number | null | undefined): string {
  const str = value == null ? "" : String(value)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export function membersToCsv(members: TeamMember[], rolePermissions: RolePermissionMap): string {
  const header = [
    "Name",
    "Email",
    "Role",
    "Status",
    "Project access",
    "Two-factor",
    "Can release money",
    "Extra permissions",
    "Revoked permissions",
    "Cost rate",
    "Bill rate",
    "Last active",
    "Invited by",
    "Member since",
  ]
  const rows = members.map((member) => {
    const { added, removed } = overrideCounts(member)
    return [
      csvCell(displayName(member).label),
      csvCell(member.user.email),
      csvCell(member.role_label),
      csvCell(member.status),
      csvCell(member.project_scope === "assigned" ? "Assigned only" : "All projects"),
      csvCell(member.mfa_enabled ? "Enabled" : "Off"),
      csvCell(canReleaseMoney(member, rolePermissions) ? "Yes" : "No"),
      csvCell(added),
      csvCell(removed),
      csvCell((member.labor_cost_rate_cents ?? 0) > 0 ? ((member.labor_cost_rate_cents ?? 0) / 100).toFixed(2) : ""),
      csvCell((member.labor_bill_rate_cents ?? 0) > 0 ? ((member.labor_bill_rate_cents ?? 0) / 100).toFixed(2) : ""),
      csvCell(member.last_active_at ? new Date(member.last_active_at).toISOString() : ""),
      csvCell(member.invited_by?.full_name ?? ""),
      csvCell(member.created_at ? new Date(member.created_at).toISOString() : ""),
    ].join(",")
  })
  return [header.join(","), ...rows].join("\n")
}

/** Build the override array the service expects from an effective grant/deny map. */
export function overridesFromMap(
  overrides: Map<string, "grant" | "deny">,
): MemberPermissionOverride[] {
  return Array.from(overrides.entries()).map(([permission_key, effect]) => ({ permission_key, effect }))
}

export function overridesToMap(overrides: MemberPermissionOverride[] | undefined): Map<string, "grant" | "deny"> {
  const map = new Map<string, "grant" | "deny">()
  for (const override of overrides ?? []) {
    map.set(override.permission_key, override.effect)
  }
  return map
}

export function groupPermissions(options: PermissionOption[]): Array<{ category: string; options: PermissionOption[] }> {
  const byCategory = new Map<string, PermissionOption[]>()
  for (const option of options) {
    const list = byCategory.get(option.category) ?? []
    list.push(option)
    byCategory.set(option.category, list)
  }
  // Financials first — it is the audit target — then the rest by size, descending.
  const ordered = Array.from(byCategory.entries()).sort((a, b) => {
    if (a[0] === "Financials") return -1
    if (b[0] === "Financials") return 1
    return b[1].length - a[1].length
  })
  return ordered.map(([category, opts]) => ({ category, options: opts }))
}
