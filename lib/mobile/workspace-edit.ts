import { z } from "zod"
import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { allowed, loadRows, requireModule } from "@/lib/mobile/workspace"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

const taskEditSchema = z.object({
  title: z.string().trim().min(2).max(500),
  description: z.string().max(10000),
  due_date: z.union([z.string().date(), z.literal("")]),
  status: z.enum(["todo", "in_progress", "blocked", "done"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
})

export async function editWorkspaceRecord(context: MobileOrgContext, moduleId: string, projectId: string | undefined, recordId: string, values: Record<string, string>) {
  const workspaceModule = await requireModule(context, moduleId, projectId)
  if (!workspaceModule.editPermission || !await allowed(context, workspaceModule.editPermission, projectId)) {
    throw new MobileAPIError(403, "edit_forbidden", "You cannot edit this record.")
  }
  return runWithServiceOrgContext(context.serviceContext, async () => {
    // Do not allow an org-scoped service to mutate a record from another project.
    const rows = await loadRows(context, workspaceModule, projectId)
    const existing = rows.find(row => (row as { id?: string }).id === recordId)
    if (!existing) throw new MobileAPIError(404, "record_not_found", "This record is not available in the selected project.")
    const input: Record<string, string | null> = {}
    for (const field of workspaceModule.editFields ?? []) {
      if (!(field.key in values)) continue
      const value = values[field.key].trim()
      if (field.required && !value) throw new MobileAPIError(422, "missing_field", `${field.label} is required.`)
      input[field.key] = field.kind === "date" && !value ? null : value
    }
    const orgId = context.orgId
    switch (moduleId) {
      case "schedule": return (await import("@/lib/mobile/workspace-schedule")).saveWorkspaceSchedule(context, (existing as { project_id: string }).project_id, input, recordId)
      case "punch": return (await import("@/lib/mobile/workspace-punch")).saveWorkspacePunch(projectId!, input, recordId)
      case "tasks": {
        const parsed = taskEditSchema.parse({ ...input, due_date: input.due_date ?? "" })
        const previous = existing as { project_id?: string | null; status: string; completed_at?: string | null }
        const taskProjectId = projectId ?? previous.project_id ?? null
        const update = { ...parsed, due_date: parsed.due_date || null,
          completed_at: parsed.status === "done" ? previous.completed_at ?? new Date().toISOString() : null }
        let query = context.serviceSupabase.from("tasks").update(update).eq("org_id", orgId).eq("id", recordId)
        query = taskProjectId ? query.eq("project_id", taskProjectId) : query.is("project_id", null)
        const { data, error } = await query.select("id").maybeSingle()
        if (error) throw new MobileAPIError(500, "task_update_failed", "The task could not be saved.")
        if (!data) throw new MobileAPIError(404, "record_not_found", "Task not found.")
        await recordAudit({ orgId, actorId: context.user.id, action: "update", entityType: "task", entityId: recordId, after: update })
        await recordEvent({ orgId, entityType: "task", entityId: recordId, eventType: "task_updated", payload: { project_id: taskProjectId, ...update } })
        return
      }
      case "closeout": {
        const { closeoutItemUpdateSchema } = await import("@/lib/validation/closeout")
        await (await import("@/lib/services/closeout")).updateCloseoutItem({ itemId: recordId, input: closeoutItemUpdateSchema.parse(input), orgId }); return
      }
      case "warranty": {
        const { warrantyRequestUpdateSchema } = await import("@/lib/validation/warranty")
        await (await import("@/lib/services/warranty")).updateWarrantyRequest({ requestId: recordId, input: warrantyRequestUpdateSchema.parse(input), orgId }); return
      }
      case "decisions": {
        const { decisionUpdateSchema } = await import("@/lib/validation/decisions")
        await (await import("@/lib/services/decisions")).updateDecision({ decisionId: recordId, input: decisionUpdateSchema.parse(input), orgId }); return
      }
      case "meetings": {
        const { updateMeetingSchema } = await import("@/lib/validation/meetings")
        await (await import("@/lib/services/meetings")).updateMeeting(recordId, updateMeetingSchema.parse(input), orgId); return
      }
      case "inspections": {
        const { updateInspectionSchema } = await import("@/lib/validation/inspections")
        await (await import("@/lib/services/inspections")).updateInspection(recordId, updateInspectionSchema.parse(input), orgId); return
      }
      case "safety": {
        const { safetyIncidentUpdateSchema } = await import("@/lib/validation/safety")
        await (await import("@/lib/services/safety")).updateSafetyIncident(recordId, safetyIncidentUpdateSchema.parse(input), orgId); return
      }
      case "directory":
      case "contacts": {
        if (input.email === "") {
          if ((existing as { email?: string }).email) throw new MobileAPIError(422, "email_required", "Enter a valid email address or keep the existing address.")
          delete input.email
        }
        if (moduleId === "directory") {
          const { companyUpdateSchema } = await import("@/lib/validation/companies")
          await (await import("@/lib/services/companies")).updateCompany({ companyId: recordId, input: companyUpdateSchema.parse(input), orgId })
        } else {
          const { contactUpdateSchema } = await import("@/lib/validation/contacts")
          await (await import("@/lib/services/contacts")).updateContact({ contactId: recordId, input: contactUpdateSchema.parse(input), orgId })
        }
        return
      }
      case "communities": {
        const { communityUpdateSchema } = await import("@/lib/validation/communities")
        await (await import("@/lib/services/communities")).updateCommunity(recordId, communityUpdateSchema.parse(input), orgId); return
      }
      case "plans": {
        const { housePlanUpdateSchema } = await import("@/lib/validation/house-plans")
        await (await import("@/lib/services/house-plans")).updateHousePlan(recordId, housePlanUpdateSchema.parse(input), orgId); return
      }
      default: throw new MobileAPIError(405, "edit_unavailable", "Editing is not available for this record.")
    }
  })
}
