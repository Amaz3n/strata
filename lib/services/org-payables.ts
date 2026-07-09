import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { requireOrgContext } from "@/lib/services/context"
import { orgBillsInboundAddress } from "@/lib/services/payables-email-ingest"
import { requireAnyPermission } from "@/lib/services/permissions"

const DAY_MS = 86_400_000
const FETCH_LIMIT = 500

/** Statuses that are no longer real obligations and never appear on the desk. */
const CLOSED_STATUSES = new Set(["void", "voided", "cancelled", "canceled"])

export interface PayableQueueRow {
  id: string
  projectId: string
  projectName: string
  billNumber: string
  vendorName: string
  status: string
  dueDate: string | null
  /** Days from today until due; negative when overdue, null when undated. */
  daysToDue: number | null
  outstandingCents: number
  partiallyPaid: boolean
  href: string
}

export interface VendorRollup {
  vendorName: string
  openCount: number
  outstandingCents: number
  nextDueDate: string | null
  hasOverdue: boolean
}

export interface HorizonBucket {
  cents: number
  count: number
}

export interface OrgPayablesDeskData {
  stats: {
    outstandingCents: number
    overdueCents: number
    overdueCount: number
    dueThisWeekCents: number
    dueThisWeekCount: number
    openCount: number
    vendorCount: number
    /** Retainage held on open bills — payable later, excluded from outstanding. */
    retainedCents: number
    /** Portion of outstanding still awaiting approval (not yet a committed outflow). */
    pendingApprovalCents: number
    pendingApprovalCount: number
  }
  /** The Cash Horizon: forward windows of outflow. Sums to outstandingCents. */
  horizon: {
    overdue: HorizonBucket
    thisWeek: HorizonBucket
    soon: HorizonBucket
    later: HorizonBucket
  }
  /** Open payables, most urgent first. */
  queue: PayableQueueRow[]
  /** Vendors ranked by what they're owed. */
  vendors: VendorRollup[]
  /** True when more open bills exist than were fetched. */
  truncated: boolean
  /** Forwarding address for emailed vendor invoices, when the org has a slug. */
  inboundBillsEmail: string | null
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function vendorNameFor(row: any) {
  const metadata = row.metadata ?? {}
  const company = one(row.company)
  return String(company?.name ?? row.qbo_vendor_name ?? metadata.vendor_name ?? "Vendor")
}

function todayMidnight() {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now
}

function daysToDueFor(dueDate: string | null, today: Date): number | null {
  if (!dueDate) return null
  const due = new Date(`${dueDate}T00:00:00`)
  return Math.round((due.getTime() - today.getTime()) / DAY_MS)
}

export async function loadOrgPayablesDesk(): Promise<OrgPayablesDeskData> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(["bill.read", "payment.read"], { supabase, orgId, userId })

  const { data: org } = await supabase.from("orgs").select("slug").eq("id", orgId).maybeSingle()

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(`
      id, project_id, bill_number, status, bill_date, due_date, total_cents, paid_cents, retainage_cents, qbo_vendor_name, metadata, created_at,
      project:projects(id, name),
      company:companies!vendor_bills_company_id_fkey(id, name)
    `)
    .eq("org_id", orgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(FETCH_LIMIT)

  if (error) throw new Error(`Failed to load payables: ${error.message}`)

  const today = todayMidnight()

  const empty = (): HorizonBucket => ({ cents: 0, count: 0 })
  const horizon = { overdue: empty(), thisWeek: empty(), soon: empty(), later: empty() }
  const vendorMap = new Map<string, VendorRollup>()
  const queue: PayableQueueRow[] = []

  let outstandingCents = 0
  let retainedCents = 0
  let pendingApprovalCents = 0
  let pendingApprovalCount = 0

  for (const row of data ?? []) {
    const status = String(row.status ?? "pending")
    if (CLOSED_STATUSES.has(status)) continue
    // Vendor credits reduce cost; they are not an obligation on the desk.
    if ((row.metadata as Record<string, any> | null)?.source === "vendor_credit") continue

    const totalCents = Number(row.total_cents ?? 0)
    const paidCents = Number(row.paid_cents ?? 0)
    const heldRetainage = Math.max(0, Number(row.retainage_cents ?? 0))
    // Same math the workbench shows: total minus held retainage minus paid.
    const outstanding = payableOutstandingCents({
      total_cents: totalCents,
      paid_cents: paidCents,
      retainage_cents: heldRetainage,
    })
    if (outstanding <= 0 && heldRetainage <= 0) continue
    if (totalCents - paidCents > 0) retainedCents += heldRetainage
    if (outstanding <= 0) continue
    if (status === "pending") {
      pendingApprovalCents += outstanding
      pendingApprovalCount += 1
    }

    const project = one(row.project)
    const dueDate = (row.due_date as string | null) ?? null
    const daysToDue = daysToDueFor(dueDate, today)
    const vendorName = vendorNameFor(row)

    outstandingCents += outstanding

    // Place the outflow on the horizon.
    const bucket =
      dueDate == null || (daysToDue != null && daysToDue > 30)
        ? horizon.later
        : daysToDue != null && daysToDue < 0
          ? horizon.overdue
          : daysToDue != null && daysToDue <= 7
            ? horizon.thisWeek
            : horizon.soon
    bucket.cents += outstanding
    bucket.count += 1

    // Vendor rollup.
    const vendor = vendorMap.get(vendorName)
    const isOverdue = daysToDue != null && daysToDue < 0
    if (vendor) {
      vendor.openCount += 1
      vendor.outstandingCents += outstanding
      vendor.hasOverdue = vendor.hasOverdue || isOverdue
      if (dueDate && (!vendor.nextDueDate || dueDate < vendor.nextDueDate)) vendor.nextDueDate = dueDate
    } else {
      vendorMap.set(vendorName, {
        vendorName,
        openCount: 1,
        outstandingCents: outstanding,
        nextDueDate: dueDate,
        hasOverdue: isOverdue,
      })
    }

    queue.push({
      id: row.id,
      projectId: row.project_id,
      projectName: String(project?.name ?? "Project"),
      billNumber: String(row.bill_number ?? "Unnumbered"),
      vendorName,
      status,
      dueDate,
      daysToDue,
      outstandingCents: outstanding,
      partiallyPaid: paidCents > 0,
      href: `/projects/${row.project_id}/financials/payables?bill=${row.id}`,
    })
  }

  const vendors = Array.from(vendorMap.values()).sort((a, b) => b.outstandingCents - a.outstandingCents)

  return {
    stats: {
      outstandingCents,
      overdueCents: horizon.overdue.cents,
      overdueCount: horizon.overdue.count,
      dueThisWeekCents: horizon.thisWeek.cents,
      dueThisWeekCount: horizon.thisWeek.count,
      openCount: queue.length,
      vendorCount: vendors.length,
      retainedCents,
      pendingApprovalCents,
      pendingApprovalCount,
    },
    horizon,
    queue,
    vendors,
    truncated: (data?.length ?? 0) >= FETCH_LIMIT,
    inboundBillsEmail: org?.slug ? orgBillsInboundAddress(org.slug as string) : null,
  }
}
