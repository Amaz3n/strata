import type { MobileOrgContext } from "@/lib/mobile/auth"
import { MobileAPIError } from "@/lib/mobile/api"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { completeMyHouseScheduleItem, listMyHouses, listMyHouseWork } from "@/lib/services/my-houses"

export async function listMobileMyHouses(context: MobileOrgContext) {
  const result = await runWithServiceOrgContext(context.serviceContext, () => listMyHouses({ userId: context.user.id, pageSize: 100 }, context.orgId))
  return result.houses.map((house) => ({
    project_id: house.projectId, lot_label: house.lotLabel, community_id: house.communityId,
    community_name: house.communityName, plan_code: house.planCode, elevation_code: house.elevationCode,
    start_date: house.startDate, target_days: house.targetDays, days_in_progress: house.daysInProgress,
    percent_complete: house.percentComplete, current_phase: house.currentPhase, late_count: house.lateCount,
    open_punch: house.openPunch, open_tasks: house.openTasks, last_daily_log_date: house.lastDailyLogDate,
  }))
}

export async function listMobileMyHouseWork(context: MobileOrgContext, window: string) {
  if (!["today", "week", "twoweek"].includes(window)) throw new MobileAPIError(400, "invalid_window", "Window must be today, week, or twoweek.")
  const groups = await runWithServiceOrgContext(context.serviceContext, () => listMyHouseWork({ window: window as "today" | "week" | "twoweek", userId: context.user.id }, context.orgId))
  return groups.map((group) => ({
    group_key: group.groupKey, group_label: group.groupLabel,
    items: group.items.map((item) => ({ schedule_item_id: item.scheduleItemId, project_id: item.projectId, lot_label: item.lotLabel, community_name: item.communityName, name: item.name, trade: item.trade, status: item.status, start_date: item.startDate, end_date: item.endDate, days_late: item.daysLate })),
  }))
}

export async function completeMobileMyHouseItem(context: MobileOrgContext, scheduleItemId: string, progress = 100) {
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new MobileAPIError(400, "invalid_progress", "Progress must be an integer from 0 to 100.")
  await runWithServiceOrgContext(context.serviceContext, () => completeMyHouseScheduleItem(scheduleItemId, context.orgId, progress))
  return { completed: true, progress }
}
