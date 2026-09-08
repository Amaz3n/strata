import type * as Actions from "@/app/(app)/projects/[id]/daily-logs/actions"

type Result<K extends keyof typeof Actions> = Awaited<ReturnType<(typeof Actions)[K]>>
async function read<K extends keyof typeof Actions>(
  projectId: string,
  mode: string,
  params: Record<string, string> = {},
): Promise<Result<K>> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/daily-logs?${new URLSearchParams({ mode, ...params })}`,
    { cache: "no-store", credentials: "same-origin" },
  )
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Your session may have expired. Refresh the page and try again.")
  return response.json()
}
export const loadDailyLogDayAction: typeof Actions.loadDailyLogDayAction = (id, date) =>
  read<"loadDailyLogDayAction">(id, "day", { date })
export const loadDailyLogHistoryAction: typeof Actions.loadDailyLogHistoryAction = (id, date) =>
  read<"loadDailyLogHistoryAction">(id, "history", { date })
export const loadDailyLogContextAction: typeof Actions.loadDailyLogContextAction = (id) =>
  read<"loadDailyLogContextAction">(id, "context")
export const resolveDailyLogDateAction: typeof Actions.resolveDailyLogDateAction = (id, logId) =>
  read<"resolveDailyLogDateAction">(id, "resolve", { logId })
export const loadDailyLogDelayMonthAction: typeof Actions.loadDailyLogDelayMonthAction = (id, date) =>
  read<"loadDailyLogDelayMonthAction">(id, "delays", { date })
export const loadPreviousDailyLogCrewsAction: typeof Actions.loadPreviousDailyLogCrewsAction = (id, date) =>
  read<"loadPreviousDailyLogCrewsAction">(id, "crews", { date })
