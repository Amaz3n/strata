import "server-only"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

export type MeetingLinkOption = { type: "rfi" | "submittal" | "change_order" | "task"; id: string; label: string; status: string | null }

export async function listMeetingLinkOptions(projectId: string, orgId?: string): Promise<MeetingLinkOption[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.read", { supabase, orgId: resolvedOrgId, userId })
  const [rfis, submittals, changes, tasks] = await Promise.all([
    supabase.from("rfis").select("id, rfi_number, subject, status").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("rfi_number", { ascending: false }).limit(250),
    supabase.from("submittals").select("id, submittal_number, title, status").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("submittal_number", { ascending: false }).limit(250),
    supabase.from("change_orders").select("id, co_number, executed_change_order_number, title, status, lifecycle").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(250),
    supabase.from("tasks").select("id, title, status").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(250),
  ])
  const failed = [rfis, submittals, changes, tasks].find((result) => result.error)
  if (failed?.error) throw new Error(`Failed to load meeting links: ${failed.error.message}`)
  return [
    ...(rfis.data ?? []).map((row) => ({ type: "rfi" as const, id: row.id, label: `RFI ${row.rfi_number}: ${row.subject}`, status: row.status })),
    ...(submittals.data ?? []).map((row) => ({ type: "submittal" as const, id: row.id, label: `Submittal ${row.submittal_number}: ${row.title}`, status: row.status })),
    ...(changes.data ?? []).map((row) => ({ type: "change_order" as const, id: row.id, label: `CO ${row.executed_change_order_number ?? row.co_number ?? "—"}: ${row.title}`, status: row.lifecycle ?? row.status })),
    ...(tasks.data ?? []).map((row) => ({ type: "task" as const, id: row.id, label: `Task: ${row.title}`, status: row.status })),
  ]
}
