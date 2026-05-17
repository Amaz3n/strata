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
import { loadFinancialsReviewQueueData } from "@/lib/services/financials-review-queue"
import { getOrgBilling } from "@/lib/services/orgs"
import type { Address } from "@/lib/types"

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

export async function loadFinancialsReceivablesData(projectId: string) {
  const [overviewData, orgBilling] = await Promise.all([
    loadFinancialsOverviewData(projectId),
    getOrgBilling().catch(() => null),
  ])

  return {
    ...overviewData,
    builderInfo: {
      name: orgBilling?.org?.name,
      email: orgBilling?.org?.billing_email,
      address: formatAddress(orgBilling?.org?.address as Address | undefined),
    },
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
