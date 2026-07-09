import { notFound } from "next/navigation"

import {
  getProjectAction,
  getProjectApprovedChangeOrderTotalAction,
  getProjectContractAction,
  getProjectScheduleAction,
  getProjectStatsAction,
  listProjectDrawsAction,
  listProjectRetainageAction,
} from "../actions"
import { getProjectFinancialFeatureConfig, isCostDrivenBillingModel } from "@/lib/financials/billing-model"
import { getBillingAutopilotState } from "@/lib/services/billing-autopilot"
import { getProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import { loadFinancialsReviewQueueData } from "@/lib/services/financials-review-queue"
import { getProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { getOrgBilling } from "@/lib/services/orgs"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import type { Address } from "@/lib/types"

import { unwrapAction } from "@/lib/action-result"

function messageForError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

function resultError(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return null
  return `${label}: ${messageForError(result.reason)}`
}

export async function loadFinancialsOverviewData(projectId: string) {
  const project = await getProjectAction(projectId)
  if (!project) notFound()

  const [stats, scheduleItems, contract, draws, retainage, approvedChangeOrdersTotalCents, reviewQueue] =
    await Promise.all([
      getProjectStatsAction(projectId),
      getProjectScheduleAction(projectId),
      getProjectContractAction(projectId),
      listProjectDrawsAction(projectId),
      listProjectRetainageAction(projectId),
      getProjectApprovedChangeOrderTotalAction(projectId),
      loadFinancialsReviewQueueData(projectId),
    ])

  return {
    project,
    stats,
    scheduleItems,
    contract,
    draws,
    retainage,
    approvedChangeOrdersTotalCents,
    reviewQueue,
  }
}

export async function loadFinancialsReceivablesData(projectId: string, selectedBillingPeriodId?: string | null) {
  const [closeData, orgBilling] = await Promise.all([
    loadFinancialsCloseData(projectId, selectedBillingPeriodId),
    getOrgBilling().catch(() => null),
  ])

  return {
    ...closeData,
    showRetainage: Number(closeData.contract?.retainage_percent ?? 0) > 0 || closeData.retainage.length > 0,
    builderInfo: {
      name: orgBilling?.org?.name,
      email: orgBilling?.org?.billing_email,
      address: formatAddress(orgBilling?.org?.address as Address | undefined),
    },
  }
}

export async function loadFinancialsCloseData(projectId: string, selectedBillingPeriodId?: string | null) {
  const [overviewData, setupStatus, feeSummaryResult, gmpSummaryResult, autopilotResult] = await Promise.allSettled([
    loadFinancialsOverviewData(projectId),
    getProjectFinancialSetupStatusForProject(projectId),
    getProjectFeeBillingSummary(projectId),
    getProjectGmpControlSummary(projectId),
    getBillingAutopilotState(projectId),
  ])

  if (overviewData.status === "rejected") throw overviewData.reason
  if (setupStatus.status === "rejected") throw setupStatus.reason

  const overview = overviewData.value
  const featureConfig = getProjectFinancialFeatureConfig(overview.project, overview.contract)
  const billingPeriods = overview.reviewQueue.billingPeriods
  const selectedPeriod =
    (selectedBillingPeriodId ? billingPeriods.find((period) => period.id === selectedBillingPeriodId) : null) ??
    billingPeriods.find((period) => ["open", "reviewing", "reopened"].includes(period.status)) ??
    billingPeriods[0] ??
    null
  const selectedPeriodId = selectedPeriod?.id ?? null
  const inSelectedPeriod = (cost: any) =>
    !selectedPeriodId ||
    cost.billing_period_id === selectedPeriodId ||
    cost.late_to_billing_period_id === selectedPeriodId
  const costsReadyToBill = overview.reviewQueue.openCosts.filter(
    (cost: any) => cost.status === "open" && cost.queue_state === "ready-to-invoice" && inSelectedPeriod(cost),
  )
  const reviewItems = [
    ...overview.reviewQueue.timeEntries,
    ...overview.reviewQueue.expenses,
    ...overview.reviewQueue.vendorBills,
  ].filter((item: any) => item.queue_state !== "billed")
  const blockedItems = reviewItems.filter((item: any) => item.queue_state === "blocked")
  const lateCosts = costsReadyToBill.filter((cost: any) => cost.late_to_billing_period_id === selectedPeriodId)

  return {
    ...overview,
    setupStatus: setupStatus.value,
    featureConfig,
    costDriven: isCostDrivenBillingModel(featureConfig.billingModel),
    billingPeriods,
    selectedPeriod,
    feeSummary:
      feeSummaryResult.status === "fulfilled" && feeSummaryResult.value.enabled ? feeSummaryResult.value : null,
    gmpSummary: gmpSummaryResult.status === "fulfilled" ? gmpSummaryResult.value : null,
    autopilot: autopilotResult.status === "fulfilled" ? autopilotResult.value : { enabled: false, run: null },
    closeSummary: {
      reviewItemCount: reviewItems.length,
      blockedItemCount: blockedItems.length,
      readyCostIds: costsReadyToBill.map((cost: any) => cost.id as string),
      readyCostCount: costsReadyToBill.length,
      readyCostCents: costsReadyToBill.reduce((sum: number, cost: any) => sum + Number(cost.billable_cents ?? 0), 0),
      lateCostCount: lateCosts.length,
      lateCostCents: lateCosts.reduce((sum: number, cost: any) => sum + Number(cost.billable_cents ?? 0), 0),
      oldestReadyCostDays: oldestAgeDays(costsReadyToBill.map((cost: any) => cost.occurred_on)),
    },
    loadErrors: [
      resultError("Fee billing", feeSummaryResult),
      resultError("GMP control", gmpSummaryResult),
      resultError("Arc Autopilot", autopilotResult),
    ].filter(Boolean) as string[],
  }
}

function formatAddress(address?: Address) {
  if (!address) return undefined
  const structured = [
    [address.street1, address.street2].filter(Boolean).join(" ").trim(),
    [address.city, address.state, address.postal_code].filter(Boolean).join(" ").trim(),
    (address.country ?? "").trim(),
  ].filter(Boolean)

  if (structured.length > 0) return structured.join("\n")
  return address.formatted?.trim() || undefined
}

function ageDays(value?: string | null) {
  if (!value) return 0
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return 0
  const today = new Date()
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const thenUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.max(0, Math.floor((todayUtc - thenUtc) / 86_400_000))
}

function oldestAgeDays(values: Array<string | null | undefined>) {
  return values.reduce((max, value) => Math.max(max, ageDays(value)), 0)
}
