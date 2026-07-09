import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createDocument } from "@/lib/services/documents"
import { createFileRecord } from "@/lib/services/files"
import { getOrgBranding } from "@/lib/services/estimate-portal"
import { renderSubcontractPdf } from "@/lib/pdfs/subcontract"
import type { QuoteLine } from "@/lib/pdfs/quote-document"
import { buildOrgScopedPath, getFilesStorageProvider, uploadFilesObject } from "@/lib/storage/files-storage"

/**
 * Renders a commitment as a branded subcontract agreement PDF (parties, scope,
 * schedule of values, retainage, terms + signature blocks), stores it, and
 * creates a draft signing document linked to the commitment. The envelope
 * wizard then hydrates from that document so the builder can place e-sign
 * fields and send — no Word doc required. Works for any commitment, whether it
 * came from a bid award or was entered directly from a sub's emailed quote.
 */
export async function generateSubcontractSigningDocument({
  commitmentId,
  orgId,
}: {
  commitmentId: string
  orgId?: string
}): Promise<{ documentId: string | null; reason?: string }> {
  // The signing engine serves source files from R2; only generate when configured.
  if (getFilesStorageProvider() !== "r2") {
    return { documentId: null, reason: "Document signing storage (R2) is not configured." }
  }

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: commitment, error } = await supabase
    .from("commitments")
    .select(
      `id, org_id, project_id, company_id, title, status, total_cents, contract_number, scope, terms, retainage_percent,
       lines:commitment_lines(id, description, quantity, unit, unit_cost_cents, sort_order),
       project:projects(name),
       company:companies(name, email)`,
    )
    .eq("id", commitmentId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (error || !commitment) {
    throw new Error(`Commitment not found: ${error?.message ?? "missing"}`)
  }
  if (!commitment.project_id) {
    throw new Error("Commitment must be linked to a project before an agreement can be generated.")
  }

  const company = (commitment as any).company as { name?: string; email?: string } | null
  const branding = await getOrgBranding(resolvedOrgId, supabase)

  const lines: QuoteLine[] = [...(((commitment as any).lines as any[]) ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_cost_cents: line.unit_cost_cents,
      item_type: "line",
    }))

  // A commitment entered as a lump sum may have no lines; the agreement still
  // needs a priced scope row for the schedule of values.
  if (lines.length === 0) {
    lines.push({
      description: commitment.scope?.trim() || commitment.title,
      quantity: 1,
      unit: "LS",
      unit_cost_cents: commitment.total_cents ?? 0,
      item_type: "line",
    })
  }

  const pdf = await renderSubcontractPdf({
    orgName: branding.name,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    title: commitment.title,
    contractNumber: commitment.contract_number ?? null,
    companyName: company?.name ?? null,
    companyEmail: company?.email ?? null,
    projectName: (commitment as any).project?.name ?? null,
    scope: commitment.scope ?? null,
    terms: commitment.terms ?? null,
    retainagePercent: commitment.retainage_percent != null ? Number(commitment.retainage_percent) : null,
    totalCents: commitment.total_cents ?? null,
    signers: [
      { role: company?.name ? `${company.name} (Subcontractor)` : "Subcontractor", name: null },
      { role: branding.name ? `${branding.name} (Contractor)` : "Contractor", name: null },
    ],
    lines,
  })

  const timestamp = Date.now()
  const fileName = `subcontract-${commitment.contract_number ?? commitment.id}.pdf`
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(
    resolvedOrgId,
    "projects",
    commitment.project_id,
    "esign",
    "source",
    `${timestamp}_${safeName}`,
  )

  await uploadFilesObject({
    supabase,
    orgId: resolvedOrgId,
    path: storagePath,
    bytes: pdf,
    contentType: "application/pdf",
    upsert: false,
  })

  const fileRecord = await createFileRecord(
    {
      project_id: commitment.project_id,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdf.length,
      visibility: "private",
      category: "contracts",
      folder_path: "/contracts",
      source: "generated",
    },
    resolvedOrgId,
  )

  const document = await createDocument(
    {
      project_id: commitment.project_id,
      document_type: "contract",
      title: commitment.title,
      source_file_id: fileRecord.id,
      source_entity_type: "subcontract",
      source_entity_id: commitment.id,
      metadata: {
        commitment_id: commitment.id,
        generated_from: "commitment",
      },
    },
    resolvedOrgId,
  )

  return { documentId: document.id }
}
