import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { documentNumberingSchema, type DocumentNumberingInput } from "@/lib/validation/document-numbering"

export async function getDocumentNumbering(orgId?: string): Promise<DocumentNumberingInput> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("orgs")
    .select("document_numbering")
    .eq("id", resolvedOrgId)
    .single()
  if (error) throw new Error(`Failed to load document numbering: ${error.message}`)
  return documentNumberingSchema.parse(data?.document_numbering ?? {})
}

export async function updateDocumentNumbering(
  input: DocumentNumberingInput,
  orgId?: string,
): Promise<DocumentNumberingInput> {
  const parsed = documentNumberingSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.settings.update", { supabase, orgId: resolvedOrgId, userId })
  const { data: before } = await supabase.from("orgs").select("document_numbering").eq("id", resolvedOrgId).single()
  const { error } = await supabase.from("orgs").update({ document_numbering: parsed }).eq("id", resolvedOrgId)
  if (error) throw new Error(`Failed to update document numbering: ${error.message}`)
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "org",
    entityId: resolvedOrgId,
    before: { document_numbering: before?.document_numbering ?? {} },
    after: { document_numbering: parsed },
  })
  return parsed
}

