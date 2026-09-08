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
import { loadCostInboxData } from "@/lib/services/cost-inbox"

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
      loadCostInboxData(projectId),
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
