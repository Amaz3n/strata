import "server-only"
import { isInspectionLifecycleEnabled } from "@/lib/inspections/lifecycle"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { requireAuthorization } from "@/lib/services/authorization"
import { hasExecutedPurchaseAgreement } from "@/lib/services/community-sales"
import { getProjectWaiverReadiness } from "@/lib/services/waiver-register"
import { readAllRows } from "@/lib/land/paging"

const itemSchema = z.object({ id: z.string().uuid(), title: z.string(), is_gate: z.boolean(),
  status: z.enum(["open", "complete", "waived"]), notes: z.string().nullable(),
  file_id: z.string().uuid().nullable(), completed_at: z.string().nullable(), completed_by: z.string().uuid().nullable() })

type ClosingScope = {
  supabase: SupabaseClient; orgId: string; userId: string; closingId: string; projectId: string
}
export async function authorizeClosingProject(input: ClosingScope) {
  await requireAuthorization({ permission: "closing.manage", orgId: input.orgId, userId: input.userId,
    projectId: input.projectId, supabase: input.supabase, resourceType: "closing", resourceId: input.closingId, logDecision: true })
}
export async function assertClosingReadiness(input: ClosingScope) {
  await authorizeClosingProject(input)
  if (isInspectionLifecycleEnabled()) {
    const { data, error } = await input.supabase.rpc("read_inspection_closing_readiness", { p_org: input.orgId, p_home: input.projectId, p_actor: input.userId })
    if (error) throw new Error(`Required inspection readiness: ${error.message}`)
    z.object({ ready: z.literal(true) }).parse(data)
  }
  const [items, executed, punch, waivers] = await Promise.all([
    readAllRows((from, to) => input.supabase.from("closing_checklist_items").select("id,title,is_gate,status,notes,file_id,completed_at,completed_by")
      .eq("org_id", input.orgId).eq("closing_id", input.closingId).order("id").range(from, to), { cap: 1001, label: "Unable to verify closing checklist" }),
    hasExecutedPurchaseAgreement(input.projectId, input.orgId),
    input.supabase.from("punch_items").select("id", { count: "exact", head: true }).eq("org_id", input.orgId)
      .eq("project_id", input.projectId).not("status", "in", "(closed,resolved)"),
    getProjectWaiverReadiness(input.projectId, "closing.manage", input.orgId),
  ])
  if (items.truncated) throw new Error("Closing checklist exceeds the supported limit; reconcile it before settlement")
  const gates = z.array(itemSchema).parse(items.rows).filter(item => item.is_gate)
  if (!gates.length) throw new Error("Closing readiness gates are missing")
  for (const gate of gates) {
    if (gate.status === "open") throw new Error(`Complete or waive the closing gate: ${gate.title}`)
    if (!gate.completed_by || !gate.completed_at || !Number.isFinite(Date.parse(gate.completed_at))) throw new Error(`Closing gate completion evidence is missing: ${gate.title}`)
    if (gate.status === "waived" && (gate.notes?.trim().length ?? 0) < 10) throw new Error(`Document a waiver reason of at least 10 characters: ${gate.title}`)
  }
  if (!executed) throw new Error("An executed purchase agreement is required")
  if (punch.error) throw new Error(`Unable to verify punch list: ${punch.error.message}`)
  if (punch.count === null || punch.count === undefined) throw new Error("Punch list count is unavailable")
  if (punch.count > 0) throw new Error("Open punch items must be cleared before closing")
  if (!waivers.ready) throw new Error(`Final waivers outstanding: ${waivers.missing.join(", ")}`)
  const fileIds = [...new Set(gates.flatMap(gate => gate.file_id ? [gate.file_id] : []))]
  for (let offset = 0; offset < fileIds.length; offset += 100) {
    const batch = fileIds.slice(offset, offset + 100)
    const { data, error } = await input.supabase.from("files").select("id").eq("org_id", input.orgId)
      .eq("project_id", input.projectId).in("id", batch)
    if (error) throw new Error(`Unable to verify closing evidence files: ${error.message}`)
    const present = new Set((data ?? []).map(row => row.id))
    if (batch.some(id => !present.has(id))) throw new Error("Closing evidence file is missing or belongs to another home")
  }
}
