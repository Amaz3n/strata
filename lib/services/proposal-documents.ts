import { createHmac } from "crypto"

import { requireOrgContext } from "@/lib/services/context"
import { createDocument } from "@/lib/services/documents"
import { createFileRecord } from "@/lib/services/files"
import { getOrgBranding } from "@/lib/services/estimate-portal"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { renderProposalPdf } from "@/lib/pdfs/proposal"
import type { QuoteLine, QuoteSigner } from "@/lib/pdfs/quote-document"
import { buildOrgScopedPath, getFilesStorageProvider, uploadFilesObject } from "@/lib/storage/files-storage"

function requireProposalSecret() {
  const secret = process.env.PROPOSAL_SECRET
  if (!secret) {
    throw new Error("Missing PROPOSAL_SECRET environment variable")
  }
  return secret
}

function proposalLinesToQuoteLines(lines: any[]): QuoteLine[] {
  return [...(lines ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .filter((line) => !(line.is_optional && line.is_selected === false))
    .map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_cost_cents: line.unit_cost_cents,
      markup_pct: line.markup_percent,
      item_type: line.line_type === "section" ? "group" : "line",
    }))
}

/**
 * Renders the proposal as a branded PDF (with org-templated terms + a signature
 * block), stores it in object storage, and creates a draft signing document
 * linked to the proposal. The builder then opens the signing wizard to place
 * e-sign fields over the signature block and send the envelope.
 *
 * Returns the created document id (or null if generation was skipped because the
 * storage provider is not configured for e-sign).
 */
export async function generateProposalSigningDocument({
  proposalId,
  orgId,
}: {
  proposalId: string
  orgId?: string
}): Promise<{ documentId: string | null; reason?: string }> {
  // The signing engine serves source files from R2; only generate when configured.
  if (getFilesStorageProvider() !== "r2") {
    return { documentId: null, reason: "Document signing storage (R2) is not configured." }
  }

  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: proposal, error } = await supabase
    .from("proposals")
    .select(
      `id, org_id, project_id, title, number, summary, terms, valid_until, total_cents, snapshot,
       lines:proposal_lines(*),
       project:projects(name),
       recipient:contacts(full_name, email)`,
    )
    .eq("id", proposalId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (error || !proposal) {
    throw new Error(`Proposal not found: ${error?.message ?? "missing"}`)
  }

  if (!proposal.project_id) {
    throw new Error("Proposal must be linked to a project before a signing document can be generated.")
  }

  const branding = await getOrgBranding(resolvedOrgId, supabase)
  const snapshot = (proposal.snapshot as Record<string, any> | null) ?? {}
  const recipient = (proposal as any).recipient as { full_name?: string; email?: string } | null

  const signers: QuoteSigner[] = [
    { role: "Client", name: recipient?.full_name ?? null },
    { role: branding.name ?? "Builder", name: null },
  ]

  const terms = proposal.terms?.trim() || branding.proposalTermsTemplate || null

  const pdf = await renderProposalPdf({
    orgName: branding.name,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    proposalTitle: proposal.title ?? "Proposal",
    proposalNumber: proposal.number ?? undefined,
    recipientName: recipient?.full_name ?? undefined,
    recipientEmail: recipient?.email ?? null,
    projectName: (proposal as any).project?.name ?? null,
    summary: proposal.summary ?? null,
    terms,
    subtotalCents: snapshot.subtotal_cents ?? null,
    taxCents: snapshot.tax_cents ?? null,
    totalCents: proposal.total_cents ?? null,
    validUntil: proposal.valid_until ?? null,
    signers,
    lines: proposalLinesToQuoteLines((proposal as any).lines ?? []),
  })

  const timestamp = Date.now()
  const fileName = `proposal-${proposal.number ?? proposal.id}.pdf`
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(
    resolvedOrgId,
    "projects",
    proposal.project_id,
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
      project_id: proposal.project_id,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdf.length,
      visibility: "private",
      category: "contracts",
      folder_path: `/projects/${proposal.project_id}/esign/source`,
      source: "generated",
    },
    resolvedOrgId,
  )

  const document = await createDocument(
    {
      project_id: proposal.project_id,
      document_type: "proposal",
      title: proposal.title ?? "Proposal",
      source_file_id: fileRecord.id,
      source_entity_type: "proposal",
      source_entity_id: proposal.id,
      metadata: {
        proposal_id: proposal.id,
        generated_from: "estimate_conversion",
        version_number: 1,
        is_current_version: true,
      },
    },
    resolvedOrgId,
  )

  return { documentId: document.id }
}

/** Renders the proposal PDF for the public portal, resolved by raw token. Returns null if not found. */
export async function renderProposalPdfByToken(
  token: string,
): Promise<{ pdf: Buffer; fileName: string } | null> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = createHmac("sha256", requireProposalSecret()).update(token).digest("hex")

  const { data: proposal, error } = await supabase
    .from("proposals")
    .select(
      `id, org_id, title, number, summary, terms, valid_until, total_cents, snapshot,
       lines:proposal_lines(*),
       project:projects(name),
       recipient:contacts(full_name, email)`,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!proposal) return null

  const branding = await getOrgBranding(proposal.org_id, supabase)
  const snapshot = (proposal.snapshot as Record<string, any> | null) ?? {}
  const recipient = (proposal as any).recipient as { full_name?: string; email?: string } | null
  const terms = proposal.terms?.trim() || branding.proposalTermsTemplate || null

  const pdf = await renderProposalPdf({
    orgName: branding.name,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    proposalTitle: proposal.title ?? "Proposal",
    proposalNumber: proposal.number ?? undefined,
    recipientName: recipient?.full_name ?? undefined,
    recipientEmail: recipient?.email ?? null,
    projectName: (proposal as any).project?.name ?? null,
    summary: proposal.summary ?? null,
    terms,
    subtotalCents: snapshot.subtotal_cents ?? null,
    taxCents: snapshot.tax_cents ?? null,
    totalCents: proposal.total_cents ?? null,
    validUntil: proposal.valid_until ?? null,
    signers: [
      { role: "Client", name: recipient?.full_name ?? null },
      { role: branding.name ?? "Builder", name: null },
    ],
    lines: proposalLinesToQuoteLines((proposal as any).lines ?? []),
  })

  return { pdf, fileName: `proposal-${proposal.number ?? proposal.id}.pdf` }
}
