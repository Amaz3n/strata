import "server-only"

import { getFinancialAccountingMode } from "@/lib/services/financial-accounting"

import type { BillingProfile, BillingProfileFacts, ReceivablesAccountingMode } from "@/lib/financials/billing-profile"
import { summarizeBillingCycle, type BillingCycleSummary } from "@/lib/financials/billing-cycle-summary"
import {
  accumulateArAging,
  emptyArAgingTotals,
  deriveInvoiceDisplayStatus,
  normalizeInvoiceStatus,
  type ArAgingTotals,
} from "@/lib/financials/invoice-lifecycle"
import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { PAY_APPLICATION_STAGE_LABELS } from "@/lib/financials/pay-app-lifecycle"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBillingAutopilotState, type BillingAutopilotState } from "@/lib/services/billing-autopilot"
import { listProjectBillingPeriods, type ProjectBillingPeriod } from "@/lib/services/billing-periods"
import { requireOrgContext } from "@/lib/services/context"
import { loadCostInboxData, toBillingCycleItems } from "@/lib/services/cost-inbox"
import { getProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import { getProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { listPayApplications } from "@/lib/services/pay-applications"
import { listPrimeSovLines } from "@/lib/services/prime-sov"

/**
 * The project billing book: the numbers a billing page opens with and the
 * planned billing events waiting in its Up next band.
 *
 * The old page ran eight `count(*)` queries for its queue chips plus a ninth
 * scan for the aging strip, and one of the eight failing took the whole strip
 * down with it. A project's invoice book is a few hundred rows at most, so ONE
 * select of the status columns yields every count, total and aging bucket the
 * page shows, measured over the same rows.
 */

export interface BillingBandCounts {
  /** Drafts still being prepared, awaiting approval, or approved and unsent. */
  drafts: number
  awaitingApproval: number
  readyToIssue: number
  open: number
  overdue: number
  /** Delivery failed or bounced — flagged inline on the row. */
  exceptions: number
  paid: number
  void: number
}

export interface ProjectBillingSummary extends ArAgingTotals {
  bands: BillingBandCounts
  billedCents: number
  collectedCents: number
  creditedCents: number
  /** Retainage the customer is holding on this job, from the ledger and the SOV. */
  retainageHeldCents: number
}

type SummaryRow = {
  status: string | null
  approval_status: string | null
  delivery_status: string | null
  balance_due_cents: number | null
  total_cents: number | null
  due_date: string | null
}

function summarizeBillingRows(
  rows: SummaryRow[],
  creditedCents: number,
  retainageHeldCents: number,
): ProjectBillingSummary {
  const billedSet: ReadonlySet<string> = new Set(BILLED_INVOICE_STATUSES)
  const bands: BillingBandCounts = { drafts: 0, awaitingApproval: 0, readyToIssue: 0, open: 0, overdue: 0, exceptions: 0, paid: 0, void: 0 }
  const aging = emptyArAgingTotals()
  let billedCents = 0
  for (const row of rows) {
    const stored = normalizeInvoiceStatus(row.status)
    const facts = { status: row.status, balanceCents: row.balance_due_cents, dueDate: row.due_date }
    const display = deriveInvoiceDisplayStatus(facts)
    if (billedSet.has(stored)) billedCents += Number(row.total_cents ?? 0)
    if (row.delivery_status === "failed" || row.delivery_status === "bounced") bands.exceptions += 1
    if (stored === "draft") {
      bands.drafts += 1
      if (row.approval_status === "pending") bands.awaitingApproval += 1
      else if (row.approval_status === "approved") bands.readyToIssue += 1
      continue
    }
    if (stored === "void") { bands.void += 1; continue }
    if (display === "paid") { bands.paid += 1; continue }
    if (display === "overdue") bands.overdue += 1
    else bands.open += 1
    accumulateArAging(aging, facts)
  }
  return {
    ...aging,
    bands,
    billedCents,
    creditedCents,
    collectedCents: Math.max(0, billedCents - aging.outstandingCents - creditedCents),
    retainageHeldCents,
  }
}

export async function getProjectBillingSummary(
  projectId: string,
  options: { includeSovRetainage?: boolean } = {},
): Promise<ProjectBillingSummary> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: false,
    resourceType: "project",
    resourceId: projectId,
  })

  const [invoicesResult, adjustmentsResult, retainageResult, sovResult] = await Promise.all([
    supabase
      .from("invoices")
      .select("status, approval_status, delivery_status, balance_due_cents, total_cents, due_date")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .throwOnError(),
    supabase
      .from("receivable_adjustments")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "posted")
      .throwOnError(),
    supabase
      .from("retainage")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "held")
      .throwOnError(),
    options.includeSovRetainage ? listPrimeSovLines(projectId, orgId).catch(() => null) : Promise.resolve(null),
  ])

  const creditedCents = (adjustmentsResult.data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
  const ledgerRetainage = (retainageResult.data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
  const sovRetainage = sovResult?.summary
    ? Math.max(0, sovResult.summary.retainage_held_cents - sovResult.summary.retainage_released_cents)
    : 0

  return summarizeBillingRows((invoicesResult.data ?? []) as SummaryRow[], creditedCents, ledgerRetainage + sovRetainage)
}

export async function getOrgBillingSummary(orgId?: string): Promise<ProjectBillingSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "invoice.read", userId, orgId: resolvedOrgId, supabase, logDecision: false, resourceType: "org", resourceId: resolvedOrgId })
  const [invoices, adjustments, retainage] = await Promise.all([
    supabase.from("invoices").select("status, approval_status, delivery_status, balance_due_cents, total_cents, due_date").eq("org_id", resolvedOrgId).throwOnError(),
    supabase.from("receivable_adjustments").select("amount_cents").eq("org_id", resolvedOrgId).eq("status", "posted").throwOnError(),
    supabase.from("retainage").select("amount_cents").eq("org_id", resolvedOrgId).eq("status", "held").throwOnError(),
  ])
  const creditedCents = (adjustments.data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
  const retainageHeldCents = (retainage.data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
  return summarizeBillingRows((invoices.data ?? []) as SummaryRow[], creditedCents, retainageHeldCents)
}

/**
 * Whether the project has a schedule of values or any pay applications. Two
 * head counts, so the profile can be decided before anything heavier loads.
 */
export async function getProjectBillingFacts(projectId: string): Promise<BillingProfileFacts> {
  const { supabase, orgId } = await requireOrgContext()
  const [sov, apps] = await Promise.all([
    supabase.from("prime_sov_lines").select("id").eq("org_id", orgId).eq("project_id", projectId).limit(1).throwOnError(),
    supabase.from("pay_applications").select("id").eq("org_id", orgId).eq("project_id", projectId).limit(1).throwOnError(),
  ])
  return { hasSov: (sov.data ?? []).length > 0, hasPayApplications: (apps.data ?? []).length > 0 }
}

/* ------------------------------------------------------------------------- *
 * Accounting mode.
 * ------------------------------------------------------------------------- */

export async function getReceivablesAccountingMode(orgId?: string, projectId?: string): Promise<ReceivablesAccountingMode> {
  return getFinancialAccountingMode(orgId, projectId)
}

/* ------------------------------------------------------------------------- *
 * Up next: the planned billing events, one row each.
 * ------------------------------------------------------------------------- */

export type UpNextRowKind =
  | "draw"
  | "period_bill"
  | "period_close"
  | "fee"
  | "pay_app"
  | "pay_app_new"
  | "retainage"
  | "deposit"
  | "closing"

export type UpNextState = "due" | "upcoming" | "blocked"

export interface UpNextRow {
  key: string
  kind: UpNextRowKind
  title: string
  detail: string
  amountCents: number | null
  state: UpNextState
  /** The one verb on the row. */
  actionLabel: string
  /** Portfolio desks deep-link the work to the project that owns it. */
  href?: string
  projectName?: string
  /** Lifecycle state shown in the register's dedicated status column. */
  statusLabel?: string
  drawId?: string
  payApplicationId?: string
  billingPeriodId?: string
  /** Period billing carries the options the old wizard asked for. */
  period?: {
    readyCostIds: string[]
    readyCostCount: number
    lateCostCount: number
    reviewItemCount: number
    blockedItemCount: number
    feeAvailableCents: number
    gmp: { status: string; overrunRisk: boolean } | null
    autopilotNotes: Array<{ id: string; title: string; description: string | null; status: string }>
  }
  /** Retainage carries how a release is executed. */
  retainage?: { mode: "sov" | "ledger"; availableCents: number }
}

export interface ProjectBillingUpNext {
  rows: UpNextRow[]
  periods: ProjectBillingPeriod[]
  selectedPeriod: ProjectBillingPeriod | null
  /** Sources that failed to load, named so the page can say so. */
  errors: string[]
}

function messageForError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function formatDay(value: string | null | undefined) {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))),
  )
}

async function loadDrawRows(input: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectId: string
  contractTotalCents: number
}): Promise<UpNextRow[]> {
  const { data: draws } = await input.supabase
    .from("draw_schedules")
    .select("id, draw_number, title, amount_cents, percent_of_contract, due_date, due_trigger, milestone_id, status, invoice_id, metadata")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("status", "pending")
    .is("invoice_id", null)
    .order("draw_number", { ascending: true })
    .limit(50)
    .throwOnError()

  const milestoneIds = (draws ?? []).map((draw) => draw.milestone_id).filter((id): id is string => Boolean(id))
  const milestones = new Map<string, { status: string | null; progress: number | null }>()
  if (milestoneIds.length > 0) {
    const { data: items } = await input.supabase
      .from("schedule_items")
      .select("id, status, progress")
      .eq("project_id", input.projectId)
      .in("id", milestoneIds)
    for (const item of items ?? []) milestones.set(String(item.id), { status: item.status, progress: item.progress })
  }

  const today = todayIso()
  return (draws ?? []).map((draw): UpNextRow => {
    const amount =
      typeof draw.percent_of_contract === "number" && input.contractTotalCents > 0
        ? Math.round((input.contractTotalCents * draw.percent_of_contract) / 100)
        : Number(draw.amount_cents ?? 0)
    const milestone = draw.milestone_id ? milestones.get(draw.milestone_id) : null
    const milestoneDone = Boolean(
      milestone && (milestone.status === "completed" || Number(milestone.progress ?? 0) >= 100),
    )
    const dateDue = Boolean(draw.due_date && draw.due_date <= today)
    const due = draw.due_trigger === "milestone" ? milestoneDone : draw.due_trigger === "date" ? dateDue : false
    const isDeposit = Number(draw.draw_number) === 0 || Boolean((draw.metadata as Record<string, unknown> | null)?.is_deposit)
    const trigger =
      draw.due_trigger === "milestone"
        ? milestoneDone
          ? "Milestone complete"
          : "When the milestone completes"
        : draw.due_date
          ? dateDue
            ? `Due ${formatDay(draw.due_date)}`
            : `Due ${formatDay(draw.due_date)}`
          : "Billed on approval"
    return {
      key: `draw:${draw.id}`,
      kind: "draw",
      title: isDeposit ? `Deposit · ${draw.title}` : `Draw ${draw.draw_number} · ${draw.title}`,
      detail: trigger,
      amountCents: amount,
      state: due ? "due" : "upcoming",
      actionLabel: "Bill",
      drawId: String(draw.id),
    }
  })
}

async function loadHeldRetainage(input: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectId: string
}): Promise<Array<{ amount_cents: number | null }>> {
  const { data } = await input.supabase
    .from("retainage")
    .select("amount_cents")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("status", "held")
    .throwOnError()
  return data ?? []
}

function periodRows(input: {
  projectId: string
  selectedPeriod: ProjectBillingPeriod | null
  summary: BillingCycleSummary
  feeAvailableCents: number
  gmp: { status: string; enabled: boolean } | null
  autopilot: BillingAutopilotState | null
}): UpNextRow[] {
  const { selectedPeriod, summary } = input
  const rows: UpNextRow[] = []
  const periodLabel = selectedPeriod ? selectedPeriod.name : "Open costs"
  const gmpOverrun = Boolean(input.gmp?.enabled && input.gmp.status === "overrun")
  const autopilotNotes = (input.autopilot?.run?.items ?? []).slice(0, 5).map((item, index) => ({
    id: item.id ?? `${item.item_type}-${index}`,
    title: item.title,
    description: item.description ?? null,
    status: item.status,
  }))
  const periodMeta: NonNullable<UpNextRow["period"]> = {
    readyCostIds: summary.readyCostIds,
    readyCostCount: summary.readyToInvoiceCount,
    lateCostCount: summary.lateCostCount,
    reviewItemCount: summary.reviewItemCount,
    blockedItemCount: summary.blockedCount,
    feeAvailableCents: input.feeAvailableCents,
    gmp: input.gmp?.enabled ? { status: input.gmp.status, overrunRisk: input.gmp.status !== "ok" } : null,
    autopilotNotes,
  }

  if (summary.readyToInvoiceCount > 0) {
    const parts = [`${summary.readyToInvoiceCount} approved cost${summary.readyToInvoiceCount === 1 ? "" : "s"}`]
    if (summary.reviewItemCount > 0) parts.push(`${summary.reviewItemCount} still in review`)
    if (summary.oldestReadyCostDays > 0) parts.push(`oldest ${summary.oldestReadyCostDays}d`)
    rows.push({
      key: `period-bill:${selectedPeriod?.id ?? "open"}`,
      kind: "period_bill",
      title: periodLabel,
      detail: parts.join(" · "),
      amountCents: summary.readyToInvoiceCents + input.feeAvailableCents,
      state: gmpOverrun ? "blocked" : summary.blockedCount > 0 ? "upcoming" : "due",
      actionLabel: "Bill",
      billingPeriodId: selectedPeriod?.id,
      period: periodMeta,
    })
  } else if (selectedPeriod && selectedPeriod.status !== "closed" && selectedPeriod.invoice_ids.length > 0) {
    rows.push({
      key: `period-close:${selectedPeriod.id}`,
      kind: "period_close",
      title: periodLabel,
      detail:
        summary.reviewItemCount > 0
          ? `Billed · ${summary.reviewItemCount} item${summary.reviewItemCount === 1 ? "" : "s"} still in review`
          : "Billed · nothing left to invoice",
      amountCents: null,
      state: summary.reviewItemCount > 0 ? "upcoming" : "due",
      actionLabel: "Close period",
      billingPeriodId: selectedPeriod.id,
      period: periodMeta,
    })
  } else if (summary.reviewItemCount > 0) {
    rows.push({
      key: `period-review:${selectedPeriod?.id ?? "open"}`,
      kind: "period_bill",
      title: periodLabel,
      detail: `${summary.reviewItemCount} cost${summary.reviewItemCount === 1 ? "" : "s"} waiting in Cost Inbox · nothing approved yet`,
      amountCents: null,
      state: "blocked",
      actionLabel: "Review costs",
      billingPeriodId: selectedPeriod?.id,
      period: periodMeta,
    })
  }
  return rows
}

export async function getProjectBillingUpNext(
  projectId: string,
  profile: BillingProfile,
  options: { selectedPeriodId?: string | null; contractTotalCents?: number } = {},
): Promise<ProjectBillingUpNext> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: false,
    resourceType: "project",
    resourceId: projectId,
  })

  const wants = new Set(profile.sources)
  const errors: string[] = []
  const note = (label: string) => (error: unknown) => {
    errors.push(`${label}: ${messageForError(error)}`)
    return null
  }

  const [draws, inbox, periods, fee, payApps, sov, retainageLedger, gmp, autopilot] = await Promise.all([
    wants.has("draws")
      ? loadDrawRows({ supabase, orgId, projectId, contractTotalCents: options.contractTotalCents ?? 0 }).catch(
          note("Draw schedule"),
        )
      : Promise.resolve(null),
    wants.has("periods") ? loadCostInboxData(projectId).catch(note("Approved costs")) : Promise.resolve(null),
    wants.has("periods") ? listProjectBillingPeriods(projectId, orgId).catch(note("Billing periods")) : Promise.resolve(null),
    wants.has("fee") || wants.has("periods")
      ? getProjectFeeBillingSummary(projectId, orgId).catch(note("Fee billing"))
      : Promise.resolve(null),
    wants.has("pay_apps") ? listPayApplications(projectId, orgId).catch(note("Pay applications")) : Promise.resolve(null),
    wants.has("pay_apps") && wants.has("retainage")
      ? listPrimeSovLines(projectId, orgId).catch(note("Schedule of values"))
      : Promise.resolve(null),
    wants.has("retainage") && !wants.has("pay_apps")
      ? loadHeldRetainage({ supabase, orgId, projectId }).catch(note("Retainage"))
      : Promise.resolve(null),
    wants.has("periods") && profile.billingModel === "cost_plus_gmp"
      ? getProjectGmpControlSummary(projectId, orgId).catch(note("GMP control"))
      : Promise.resolve(null),
    wants.has("periods") ? getBillingAutopilotState(projectId).catch(note("Arc Autopilot")) : Promise.resolve(null),
  ])

  const rows: UpNextRow[] = []

  if (draws) rows.push(...draws)

  const periodList = periods ?? []
  const selectedPeriod =
    (options.selectedPeriodId ? periodList.find((period) => period.id === options.selectedPeriodId) : null) ??
    periodList.find((period) => ["open", "reviewing", "reopened"].includes(period.status)) ??
    periodList[0] ??
    null

  if (wants.has("periods") && inbox) {
    const summary = summarizeBillingCycle(toBillingCycleItems(inbox), { billingPeriodId: selectedPeriod?.id ?? null })
    const feeAvailableCents =
      profile.billingModel === "cost_plus_fixed_fee" && fee?.enabled ? Math.max(0, fee.billable_fee_cents) : 0
    rows.push(
      ...periodRows({
        projectId,
        selectedPeriod,
        summary,
        feeAvailableCents,
        gmp: gmp ? { status: gmp.status, enabled: gmp.enabled } : null,
        autopilot,
      }),
    )
  }

  if (wants.has("fee") && fee?.enabled && fee.billable_fee_cents > 0 && !wants.has("periods")) {
    rows.push({
      key: "fee",
      kind: "fee",
      title: "Earned fee",
      detail: `${fee.project_percent_complete.toFixed(0)}% complete · ${((fee.billed_fee_cents / Math.max(1, fee.total_fee_cents)) * 100).toFixed(0)}% billed`,
      amountCents: fee.billable_fee_cents,
      state: "due",
      actionLabel: "Bill",
    })
  }

  if (wants.has("pay_apps")) {
    // Everything that is not finished with somebody. The old filter asked only
    // for drafts and unsent submissions, so an application the owner had been
    // sent — or had returned — vanished from the page that is supposed to be
    // tracking it.
    const inFlight = (payApps ?? []).filter((app) =>
      ["draft", "returned", "submitted", "awaiting_certification"].includes(app.stage),
    )
    for (const app of inFlight) {
      const title = `${app.is_retainage_release ? "Retainage release" : "Pay application"} #${app.application_number}${
        app.revision > 0 ? ` · revision ${app.revision}` : ""
      }`
      const period = `Period ending ${formatDay(app.period_end) ?? app.period_end}`
      const row: UpNextRow = {
        key: `payapp:${app.id}`,
        kind: "pay_app",
        title,
        detail: period,
        amountCents: app.status === "draft" ? null : app.current_payment_due_cents,
        state: "due",
        actionLabel: "Continue",
        statusLabel: PAY_APPLICATION_STAGE_LABELS[app.stage],
        payApplicationId: app.id,
      }
      if (app.stage === "returned") {
        const reason = app.returns[app.returns.length - 1]?.reason
        row.detail = reason ? `Returned by the owner · ${reason}` : "Returned by the owner"
        row.actionLabel = "Revise"
      } else if (app.stage === "submitted") {
        row.detail = `${period} · ${app.certification_required ? "not sent to the owner" : "invoice not sent"}`
        row.actionLabel = "Send"
      } else if (app.stage === "awaiting_certification") {
        const sentOn = app.sent_to_owner ? formatDay(app.sent_to_owner.at.slice(0, 10)) : null
        row.detail = sentOn ? `Sent ${sentOn} · waiting on the owner's certificate` : "Waiting on the owner's certificate"
        // The ball is with the owner, so this is not the builder's due work.
        row.state = "upcoming"
        row.actionLabel = "Open"
      }
      rows.push(row)
    }
    if (inFlight.length === 0) {
      rows.push({
        key: "payapp:new",
        kind: "pay_app_new",
        title: "Next pay application",
        detail: "Enter progress against the schedule of values and submit it to bill the owner",
        amountCents: null,
        state: "upcoming",
        actionLabel: "Start",
        statusLabel: "Planned",
      })
    }
  }

  if (wants.has("retainage")) {
    if (sov?.summary) {
      const available = sov.summary.retainage_held_cents - sov.summary.retainage_released_cents
      if (available > 0) {
        rows.push({
          key: "retainage:sov",
          kind: "retainage",
          title: "Retainage held by the owner",
          detail: "Release creates a retainage-release pay application and its invoice",
          amountCents: available,
          state: "upcoming",
          actionLabel: "Release",
          retainage: { mode: "sov", availableCents: available },
        })
      }
    } else if (retainageLedger) {
      const available = retainageLedger.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
      if (available > 0) {
        rows.push({
          key: "retainage:ledger",
          kind: "retainage",
          title: "Retainage held",
          detail: "Release it into an invoice when the contract allows",
          amountCents: available,
          state: "upcoming",
          actionLabel: "Release",
          retainage: { mode: "ledger", availableCents: available },
        })
      }
    }
  }

  if (wants.has("deposit")) {
    rows.push({
      key: "deposit",
      kind: "deposit",
      title: "Buyer deposit",
      detail: "Earnest money held as a customer deposit until closing",
      amountCents: null,
      state: "upcoming",
      actionLabel: "Request",
    })
  }
  if (wants.has("closing")) {
    rows.push({
      key: "closing",
      kind: "closing",
      title: "Closing statement",
      detail: "Settle deposits, options and incentives at closing",
      amountCents: null,
      state: "upcoming",
      actionLabel: "Open closing",
    })
  }

  return { rows, periods: periodList, selectedPeriod, errors }
}
