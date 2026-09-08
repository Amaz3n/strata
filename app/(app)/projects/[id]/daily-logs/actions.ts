"use server"

import { z } from "zod"
import { format, startOfMonth, endOfMonth } from "date-fns"
import { runAction } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission, hasPermission } from "@/lib/services/permissions"
import { listProjectLocations } from "@/lib/services/locations"
import { readDailyLogPages } from "@/lib/services/daily-log-pages"
import {
  getProjectDailyLogsAction,
  getProjectDailyReportsAction,
  getProjectFilesAction,
  getProjectScheduleAction,
  getProjectTasksAction,
  listProjectPunchItemsAction,
  getProjectTeamAction,
} from "../actions"

export async function loadDailyLogDayAction(projectId: string, date: string) {
  return runAction(async () => {
    z.string().uuid().parse(projectId)
    z.string().date().parse(date)
    const [logs, reports, photos] = await Promise.all([
      getProjectDailyLogsAction(projectId, date),
      getProjectDailyReportsAction(projectId, date),
      getProjectFilesAction(projectId, undefined, date),
    ])
    const files = await getProjectFilesAction(
      projectId,
      logs.map((log) => log.id),
    )
    return { date, logs, reports, files: [...files, ...photos] }
  })
}

export async function resolveDailyLogDateAction(projectId: string, logId: string) {
  return runAction(async () => {
    z.string().uuid().parse(logId)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.read")
    const { data, error } = await supabase
      .from("daily_logs")
      .select("log_date")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", logId)
      .single()
    if (error || !data) throw new Error("This log is unavailable.")
    return String(data.log_date)
  })
}

export async function loadDailyLogHistoryAction(projectId: string, month: string) {
  return runAction(async () => {
    z.string().date().parse(month)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.read")
    const date = new Date(`${month}T12:00:00`)
    const from = format(startOfMonth(date), "yyyy-MM-dd")
    const to = format(endOfMonth(date), "yyyy-MM-dd")
    const [{ data: logs }, { data: reports }] = await Promise.all([
      readDailyLogPages((first, last) =>
        supabase
          .from("daily_logs")
          .select("id, log_date, summary")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .gte("log_date", from)
          .lte("log_date", to)
          .order("log_date", { ascending: false })
          .order("id")
          .range(first, last),
      ),
      readDailyLogPages((first, last) =>
        supabase
          .from("daily_reports")
          .select("report_date, status")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .gte("report_date", from)
          .lte("report_date", to)
          .order("report_date", { ascending: false })
          .order("id")
          .range(first, last),
      ),
    ])
    const days = new Map<string, { date: string; summary: string; status: string; count: number; searchText: string }>()
    for (const report of reports)
      days.set(report.report_date, {
        date: report.report_date,
        summary: "Day report",
        status: report.status,
        count: 0,
        searchText: "",
      })
    for (const log of logs) {
      const day = days.get(log.log_date) ?? {
        date: log.log_date,
        summary: "",
        status: "draft",
        count: 0,
        searchText: "",
      }
      day.count += 1
      day.searchText += ` ${log.summary ?? ""}`
      if ((!day.summary || day.summary === "Day report") && log.summary?.trim())
        day.summary = log.summary.trim().split("\n")[0]
      days.set(day.date, day)
    }
    return Array.from(days.values()).sort((a, b) => b.date.localeCompare(a.date))
  })
}

export async function loadDailyLogContextAction(projectId: string) {
  return runAction(async () => {
    const { userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.read")
    const [scheduleItems, tasks, punchItems, team, locations, canManageLocations] = await Promise.all([
      getProjectScheduleAction(projectId),
      getProjectTasksAction(projectId),
      listProjectPunchItemsAction(projectId),
      getProjectTeamAction(projectId),
      listProjectLocations(projectId),
      hasPermission("project.manage"),
    ])
    return {
      scheduleItems,
      tasks,
      punchItems,
      locations,
      canManageLocations,
      mentionableUsers: team.map((member) => ({
        id: member.user_id,
        name: member.full_name,
        email: member.email,
        avatar_url: member.avatar_url,
        role: member.role_label,
      })),
    }
  })
}

/** Delay review has its own month scope; it never expands capture's initial payload. */
export async function loadDailyLogDelayMonthAction(projectId: string, month: string) {
  return runAction(async () => {
    z.string().date().parse(month)
    const date = new Date(`${month}T12:00:00`)
    return getProjectDailyReportsAction(
      projectId,
      format(startOfMonth(date), "yyyy-MM-dd"),
      format(endOfMonth(date), "yyyy-MM-dd"),
    )
  })
}

export async function loadPreviousDailyLogCrewsAction(projectId: string, date: string) {
  return runAction(async () => {
    z.string().date().parse(date)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.read")
    const { data, error } = await supabase
      .from("daily_reports")
      .select("report_date, manpower:daily_report_manpower!inner(company, trade, workers, hours)")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .lt("report_date", date)
      .order("report_date", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error("Unable to load previous crews")
    return data
      ? {
          fromDate: String(data.report_date),
          rows: data.manpower.map((row) => ({
            company: row.company ?? undefined,
            trade: row.trade ?? undefined,
            workers: row.workers ?? undefined,
            hours: row.hours ?? undefined,
          })),
        }
      : null
  })
}
