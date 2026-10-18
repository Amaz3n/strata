import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { documentFieldInputSchema } from "@/lib/validation/documents"

export function normalizeSingleSignerTemplate(fields: unknown, recipients: unknown) {
  const parsed = z.array(documentFieldInputSchema).min(1, "Template needs signing fields").parse(fields)
  const roles = new Set(parsed.map(field => field.signer_role?.trim() || "signer_1"))
  for (const recipient of z.array(z.object({ role: z.string().optional(), signer_role: z.string().optional() })).parse(recipients ?? [])) {
    if ((recipient.role ?? "signer") === "signer") roles.add(recipient.signer_role?.trim() || "signer_1")
  }
  if (roles.size > 1) throw new Error("Bulk sending supports one signer role per template; use a regular envelope for multiple signers")
  return parsed.map(field => ({ ...field, signer_role: "signer_1" }))
}

const reservationSchema = z.object({
  orgId: z.string().uuid(), userId: z.string().uuid(), templateId: z.string().uuid(),
  projectId: z.string().uuid(), batchId: z.string().uuid(),
  recipient: z.object({ email: z.string().trim().email().transform(value => value.toLowerCase()), name: z.string().trim().max(300).optional(), title: z.string().trim().max(500).optional() }),
})

export async function reserveBulkTemplateDocument(input: z.input<typeof reservationSchema>) {
  const parsed = reservationSchema.parse(input)
  const supabase = createServiceSupabaseClient()
  await requireAuthorization({ supabase, orgId: parsed.orgId, userId: parsed.userId, projectId: parsed.projectId, permission: "project.manage" })
  const { data, error } = await supabase.rpc("reserve_esign_bulk_document", {
    p_org_id: parsed.orgId, p_user_id: parsed.userId, p_template_id: parsed.templateId,
    p_project_id: parsed.projectId, p_batch_id: parsed.batchId, p_recipient: parsed.recipient,
  })
  if (error || !data) throw new Error(`Could not reserve bulk signing document: ${error?.message ?? "missing document"}`)
  return data as { id: string; status: string; metadata: Record<string, any>; [key: string]: any }
}

export async function updateESignTemplate(input: {
  templateId: string; name?: string; description?: string | null; archived?: boolean
}, orgId?: string) {
  const parsed = z.object({ templateId: z.string().uuid(), name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(), archived: z.boolean().optional() }).parse(input)
  const context = await requireOrgContext(orgId)
  const { data: template, error: loadError } = await context.supabase.from("esign_templates")
    .select("id, project_id").eq("org_id", context.orgId).eq("id", parsed.templateId).single()
  if (loadError || !template) throw new Error("Template not found")
  await requireAuthorization({ ...context, permission: "project.manage", projectId: template.project_id ?? undefined })
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.description !== undefined) patch.description = parsed.description
  if (parsed.archived !== undefined) patch.archived_at = parsed.archived ? new Date().toISOString() : null
  if (!Object.keys(patch).length) throw new Error("No template changes provided")
  const { data, error } = await context.supabase.from("esign_templates").update(patch)
    .eq("org_id", context.orgId).eq("id", parsed.templateId).select("*").single()
  if (error || !data) throw new Error(`Could not update template: ${error?.message ?? "missing template"}`)
  return data
}

export async function archiveESignTemplate(templateId: string, orgId?: string) {
  return updateESignTemplate({ templateId, archived: true }, orgId)
}
