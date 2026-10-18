import { z } from "zod"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { MobileAPIError } from "@/lib/mobile/api"

const punchFields = z.object({
  title: z.string().trim().min(2).max(500),
  description: z.string().max(10000).optional(),
  location: z.string().max(500).optional(),
  severity: z.string().max(80).optional(),
  due_date: z.union([z.string().date(), z.literal("")]).nullable().optional(),
  verification_required: z.enum(["true", "false"]).optional(),
})
const punchEdit = punchFields.extend({
  status: z.enum(["open", "in_progress", "ready_for_review", "closed"]),
  verification_notes: z.string().max(10000).optional(),
})

/** Caller verifies module permissions and the record's project before entering. */
export async function saveWorkspacePunch(projectId: string, values: Record<string, unknown>, recordId?: string) {
  const service = await import("@/app/(app)/projects/[id]/actions")
  const parsed = recordId ? punchEdit.parse(values) : punchFields.parse(values)
  const input = { ...parsed, due_date: parsed.due_date || null,
    verification_required: parsed.verification_required === undefined ? undefined : parsed.verification_required === "true" }
  const result = recordId ? await service.updateProjectPunchItemAction(projectId, recordId, input)
    : await service.createProjectPunchItemAction(projectId, input)
  if (!result.success) throw new MobileAPIError(422, "punch_save_failed", result.error)
  return result.data
}

export async function punchAssignmentChoices(context: MobileOrgContext, projectId: string) {
  const { data, error } = await context.serviceSupabase.from("project_vendors")
    .select("company_id,company:companies(name)").eq("org_id", context.orgId).eq("project_id", projectId)
  if (error) throw new MobileAPIError(500, "assignments_unavailable", "Project companies could not be loaded.")
  return [...new Map((data ?? []).filter((row: any) => row.company_id).map((row: any) => [row.company_id, { id: row.company_id as string, name: (Array.isArray(row.company) ? row.company[0] : row.company)?.name ?? "Company" }])).values()]
}
